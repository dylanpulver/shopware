/* istanbul ignore file */

/* Vue devtools plugins couldn't be tested well yet; the DOM logic lives in block-inspector-dom.ts and is tested there. */
/**
 * @sw-package framework
 * @private
 *
 * "Shopware Extension Blocks" inspector for the Vue devtools.
 *
 * Lists every extension block that is currently in the DOM, grouped by the component that owns it,
 * highlights the selected block in the page and lets the developer pick a block by clicking on it -
 * the block counterpart of the position identifier inspector for apps.
 *
 * The inspector reads the `data-sw-block` markers the template factory and `<sw-block>` render
 * while the block inspector is enabled. Markers are opt-in and need a reload, which the inspector's
 * power action takes care of.
 */

import type { CustomInspectorNode, CustomInspectorState } from '@vue/devtools-api';
import type { DevtoolsPluginApi } from '@vue/devtools-api/lib/esm/api/api';
import TemplateFactory from 'src/core/factory/template.factory';
import { getBlockEntries } from 'src/core/factory/twig-block-index';
import { getNativeBlockExtensionTargets } from 'src/core/factory/native-extension-targets';
import {
    getInspectedBlock,
    isBlockInspectorEnabled,
    setBlockInspectorEnabled,
    type InspectedBlock,
} from 'src/core/factory/block-inspector';
import useBlockContext from 'src/app/composables/use-block-context';
import {
    collectMarkedBlocks,
    createBlockOverlay,
    enclosingBlockNames,
    findBlockElements,
    startBlockPicking,
} from './block-inspector-dom';

/**
 * @private
 */
export const BLOCK_INSPECTOR_ID = 'sw-admin-extension-block-inspector';

const BLOCK_NODE_PREFIX = 'block:';
const COMPONENT_NODE_PREFIX = 'component:';
const DISABLED_NODE_ID = 'disabled';
const TREE_REFRESH_DELAY = 300;

const TAG_TWIG = { label: 'twig', textColor: 0xffffff, backgroundColor: 0x189eff };
const TAG_NATIVE = { label: 'native', textColor: 0xffffff, backgroundColor: 0x37d046 };
const TAG_EXTENDED = { label: 'extended', textColor: 0xffffff, backgroundColor: 0xde294c };

type TemplateOverride = { raw: string | null };

function blockNodeId(blockName: string): string {
    return `${BLOCK_NODE_PREFIX}${blockName}`;
}

function blockNameFromNodeId(nodeId: string): string | null {
    return nodeId.startsWith(BLOCK_NODE_PREFIX) ? nodeId.slice(BLOCK_NODE_PREFIX.length) : null;
}

function describeBlock(blockName: string): InspectedBlock {
    return getInspectedBlock(blockName) ?? { name: blockName, component: 'unknown', kind: 'native' };
}

/** Twig overrides of the owning component that redefine the block. */
function countTwigOverrides(block: InspectedBlock): number {
    const overrides = TemplateFactory.getTemplateOverrides(block.component) as TemplateOverride[];
    const blockPattern = new RegExp(`{%\\s*block\\s+${block.name}\\s*%}`);
    const componentOverrides = overrides.filter((override) => blockPattern.test(override.raw ?? '')).length;

    // Legacy overrides aimed at a native block are indexed separately and rendered through shim slots.
    return componentOverrides + getBlockEntries(block.name).length;
}

function countNativeExtensions(blockName: string): number {
    return useBlockContext().getBlocks(blockName).length;
}

function isExtended(block: InspectedBlock): boolean {
    return countTwigOverrides(block) > 0 || countNativeExtensions(block.name) > 0;
}

function twigSnippet(block: InspectedBlock): string {
    return [
        `Shopware.Component.override('${block.component}', {`,
        `    template: \`{% block ${block.name} %}{% parent %}{% endblock %}\`,`,
        '});',
    ].join('\n');
}

function nativeSnippet(block: InspectedBlock): string {
    return [
        `<sw-block extends="${block.name}">`,
        '    <sw-block-parent />',
        '</sw-block>',
    ].join('\n');
}

function buildTree(filter: string): CustomInspectorNode[] {
    if (!isBlockInspectorEnabled()) {
        return [
            {
                id: DISABLED_NODE_ID,
                label: 'Block markers are off - use the power action above to enable them and reload',
            },
        ];
    }

    const query = filter.trim().toLowerCase();
    const componentNodes = new Map<string, CustomInspectorNode>();

    collectMarkedBlocks().forEach((_, blockName) => {
        const block = describeBlock(blockName);

        if (query && !blockName.toLowerCase().includes(query) && !block.component.toLowerCase().includes(query)) {
            return;
        }

        let componentNode = componentNodes.get(block.component);

        if (!componentNode) {
            componentNode = {
                id: `${COMPONENT_NODE_PREFIX}${block.component}`,
                label: block.component,
                children: [],
            };
            componentNodes.set(block.component, componentNode);
        }

        const tags = [block.kind === 'twig' ? TAG_TWIG : TAG_NATIVE];

        if (isExtended(block)) {
            tags.push(TAG_EXTENDED);
        }

        componentNode.children?.push({
            id: blockNodeId(blockName),
            label: blockName,
            tags,
        });
    });

    return Array.from(componentNodes.values());
}

function buildState(blockName: string): CustomInspectorState {
    const block = describeBlock(blockName);
    const elements = findBlockElements(blockName);
    const nativeTargets = getNativeBlockExtensionTargets();

    return {
        Block: [
            { key: 'Name', value: block.name },
            { key: 'Component', value: block.component },
            { key: 'Kind', value: block.kind === 'twig' ? 'Twig template block' : 'Native <sw-block>' },
            { key: 'Elements in DOM', value: elements.length },
            { key: 'Enclosing blocks', value: enclosingBlockNames(elements[0]?.parentElement ?? null) },
        ],
        Extensions: [
            { key: 'Twig overrides', value: countTwigOverrides(block) },
            { key: 'Native <sw-block extends>', value: countNativeExtensions(block.name) },
            { key: 'Native extension target', value: nativeTargets.has(block.name) },
        ],
        Snippets: [
            { key: 'Twig override', value: twigSnippet(block) },
            { key: 'Native extension', value: nativeSnippet(block) },
        ],
    };
}

/**
 * Adds the block inspector to the Shopware devtools plugin.
 *
 * @private
 */
export default function setupBlockInspector(api: DevtoolsPluginApi<unknown>): void {
    const overlay = createBlockOverlay();
    let stopPicking: (() => void) | null = null;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;

    const highlightBlock = (blockName: string): void => {
        overlay.show(blockName, findBlockElements(blockName));
    };

    const pickBlock = (): void => {
        stopPicking?.();
        stopPicking = startBlockPicking({
            onHover(blockName, elements) {
                if (blockName) {
                    overlay.show(blockName, elements);
                } else {
                    overlay.hide();
                }
            },
            onPick(blockName) {
                api.sendInspectorTree(BLOCK_INSPECTOR_ID);
                api.selectInspectorNode(BLOCK_INSPECTOR_ID, blockNodeId(blockName));
                highlightBlock(blockName);
            },
            onStop() {
                stopPicking = null;
            },
        });
    };

    api.addInspector({
        id: BLOCK_INSPECTOR_ID,
        label: 'Shopware Extension Blocks',
        icon: 'view_quilt',
        treeFilterPlaceholder: 'Filter blocks or components',
        actions: [
            {
                icon: 'power_settings_new',
                tooltip: isBlockInspectorEnabled() ? 'Disable block markers and reload' : 'Enable block markers and reload',
                action: (): void => {
                    setBlockInspectorEnabled(!isBlockInspectorEnabled());
                    window.location.reload();
                },
            },
            {
                icon: 'ads_click',
                tooltip: 'Pick a block in the page (Escape cancels)',
                action: pickBlock,
            },
            {
                icon: 'flash_off',
                tooltip: 'Remove the highlight',
                action: (): void => {
                    stopPicking?.();
                    overlay.hide();
                },
            },
        ],
    });

    api.on.getInspectorTree((payload) => {
        if (payload.inspectorId !== BLOCK_INSPECTOR_ID) {
            return;
        }

        payload.rootNodes = buildTree(payload.filter ?? '');
    });

    api.on.getInspectorState((payload) => {
        if (payload.inspectorId !== BLOCK_INSPECTOR_ID) {
            return;
        }

        const blockName = blockNameFromNodeId(payload.nodeId);

        if (!blockName) {
            overlay.hide();

            return;
        }

        payload.state = buildState(blockName);
        highlightBlock(blockName);
    });

    if (!isBlockInspectorEnabled()) {
        return;
    }

    // Blocks come and go with routes and conditions; keep the tree current without a manual refresh.
    const observer = new MutationObserver(() => {
        if (refreshTimer) {
            clearTimeout(refreshTimer);
        }

        refreshTimer = setTimeout(() => {
            refreshTimer = null;
            api.sendInspectorTree(BLOCK_INSPECTOR_ID);
            overlay.refresh();
        }, TREE_REFRESH_DELAY);
    });

    observer.observe(document.body, { childList: true, subtree: true });
}
