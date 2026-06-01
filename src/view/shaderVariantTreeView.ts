import * as vscode from 'vscode';
import { CancellationToken, DocumentSymbol, DocumentSymbolRequest, DocumentUri, LanguageClient, ProtocolNotificationType, ProtocolRequestType, Range, SymbolInformation, SymbolKind, TextDocumentIdentifier, TextDocumentItem, TextDocumentRegistrationOptions } from 'vscode-languageclient/node';
// LSP protocol types for sending a synthetic didChange (forces server re-parse without dirtying the editor).
import { DidChangeTextDocumentNotification } from 'vscode-languageserver-protocol';
import { resolveVSCodeVariables, ShaderLanguageClient } from '../client';

interface ShaderVariantSerialized {
    url: DocumentUri,
    shadingLanguage: string,
    entryPoint: string,
    stage: string | null,
    defines: Object,
    includes: string[],
}

function shaderVariantToSerialized(
    url: DocumentUri,
    languageId: string,
    e: ShaderVariant,
    definesOverride?: { [key: string]: string },
) : ShaderVariantSerialized {
    return {
        url: url,
        shadingLanguage: languageId,
        entryPoint: e.name,
        stage: (e.stage.stage === ShaderStage.auto) ? null : ShaderStage[e.stage.stage],
        defines: definesOverride ?? Object.fromEntries(e.defines.defines.map(e => [e.label, e.value])),
        includes: e.includes.includes.map(e => resolveVSCodeVariables(e.include))
    };
}
// Notification from client to change shader variant
interface DidChangeShaderVariantParams {
    shaderVariant: ShaderVariantSerialized | null
}
interface DidChangeShaderVariantRegistrationOptions extends TextDocumentRegistrationOptions {}

const didChangeShaderVariantNotification = new ProtocolNotificationType<DidChangeShaderVariantParams, DidChangeShaderVariantRegistrationOptions>('textDocument/didChangeShaderVariant');

// Request from server to send file active variant.
interface ShaderVariantParams extends TextDocumentIdentifier {}
interface ShaderVariantRegistrationOptions extends TextDocumentRegistrationOptions {}

interface ShaderVariantResponse {
    shaderVariant: ShaderVariantSerialized | null,
}
const shaderVariantRequest = new ProtocolRequestType<ShaderVariantParams, ShaderVariantResponse, never, void, ShaderVariantRegistrationOptions>('textDocument/shaderVariant');


export type ShaderVariantDefine = {
    kind: 'define',
    label: string,
    value: string,
};

export type ShaderVariantDefineList = {
    kind: 'defineList',
    defines: ShaderVariantDefine[],
};

export type ShaderVariantInclude = {
    kind: 'include',
    include: string,
};

export type ShaderVariantIncludeList = {
    kind: 'includeList',
    includes: ShaderVariantInclude[],
};

export enum ShaderStage {
    auto,
    vertex,
    fragment,
    compute,
    tesselationControl,
    tesselationEvaluation,
    mesh,
    task,
    geometry,
    rayGeneration,
    closestHit,
    anyHit,
    callable,
    miss,
    intersect,
}

export type ShaderVariantStage = {
    kind: 'stage',
    stage: ShaderStage,
};

// This should be shadervariant.
export type ShaderVariant = {
    kind: 'variant';
    uri: vscode.Uri;
    name: string;
    custom?: string;
    isActive: boolean;
    // Per variant data
    stage: ShaderVariantStage;
    defines: ShaderVariantDefineList;
    includes: ShaderVariantIncludeList;
};

export type ShaderVariantFile = {
    kind: 'file',
    uri: vscode.Uri,
    variants: ShaderVariant[],
};

export type ShaderEntryPoint = {
    entryPoint: string,
    range: vscode.Range,
};

// --- Grouped display nodes (computed from ShaderVariantFile.variants; not persisted) ---
// The panel groups a file's permutations by entry point. Each entryGroup shows the shared stage,
// the defines common to ALL its permutations, the shared includes, and a 'defines' list with one
// node per permutation. The active checkbox lives on the permutation node, which shows only the
// defines that differ from the group's common defines. These nodes use contextValues that do not
// match any package.json menu 'when' clause, so they carry no manual add/edit/delete inline icons.
export type ShaderReadonlyDefine = { kind: 'readonlyDefine', label: string, value: string, groupName?: string };
export type ShaderReadonlyInclude = { kind: 'readonlyInclude', include: string };
export type ShaderGroupStage = { kind: 'groupStage', stage: ShaderStage };
export type ShaderCommonDefineList = { kind: 'commonDefineList', defines: ShaderReadonlyDefine[] };
export type ShaderGroupIncludeList = { kind: 'groupIncludeList', includes: ShaderReadonlyInclude[] };
export type ShaderPermutation = {
    kind: 'permutation',
    variant: ShaderVariant,             // underlying full permutation (drives active state & server notify)
    label: string,
    deltaDefines: ShaderReadonlyDefine[],
};
export type ShaderPermutationList = { kind: 'permutationList', permutations: ShaderPermutation[] };

// --- Varying defines (interactive define-matrix selector) ---
// Lists every (key,value) pair that differs across an entry group's permutations. Each value has a
// checkbox; checking a value auto-clears sibling values for the same key (radio behaviour via the
// varyingSelection map). The parent label shows the matched permutation index or "#invalid".
export type ShaderVaryingDefineValue = {
    kind: 'varyingDefineValue',
    label: string,           // the value (e.g. "0", "1")
    defineKey: string,       // parent key (e.g. "DIM_ALPHA_CHANNEL")
    selectionKey: string,    // composite "${filePath}::${entryGroupName}"
    flat: boolean,           // true when this is rendered flat under varyingDefineList (2-value key)
};
export type ShaderVaryingDefine = {
    kind: 'varyingDefine',
    label: string,           // the define key name
    selectionKey: string,
    values: ShaderVaryingDefineValue[],
};
export type ShaderVaryingDefineList = {
    kind: 'varyingDefineList',
    selectionKey: string,
    defines: ShaderVaryingDefine[],
};

// Directory node for the tree-view mode (flat vs hierarchical file list).
export type ShaderDirectoryNode = {
    kind: 'directory',
    name: string,          // display name (single path segment)
    relPath: string,       // relative path from workspace root (key)
    children: ShaderVariantNode[],
    fileCount: number,     // total files recursively under this directory
};

export type ShaderEntryGroup = {
    kind: 'entryGroup',
    uri: vscode.Uri,
    name: string,
    permutationCount: number,
    stageNode: ShaderGroupStage,
    commonDefineList: ShaderCommonDefineList,
    varyingDefineList: ShaderVaryingDefineList,
    includeList: ShaderGroupIncludeList,
    permutationList: ShaderPermutationList,
};

export type ShaderVariantNode = ShaderVariant | ShaderVariantFile | ShaderVariantDefineList | ShaderVariantIncludeList | ShaderVariantDefine | ShaderVariantInclude | ShaderVariantStage
    | ShaderEntryGroup | ShaderGroupStage | ShaderCommonDefineList | ShaderGroupIncludeList | ShaderPermutationList | ShaderPermutation | ShaderReadonlyDefine | ShaderReadonlyInclude
    | ShaderVaryingDefineList | ShaderVaryingDefine | ShaderVaryingDefineValue | ShaderDirectoryNode;

// Configuration file schema used by the shader-validator.variantFolder import feature.
// A config describes the variants of one shader (single-file form) or several (multi-file form).
export interface ShaderVariantConfigVariant {
    entryPoint: string,
    custom?: string,
    stage?: string | null,
    defines?: { [key: string]: string | number },
    includes?: string[],
}
export interface ShaderVariantConfigFile {
    file?: string,
    language?: string,
    // Common defines/includes applied to every variant of this file. A variant's own defines/
    // includes take precedence on conflict. Lets a config factor out macros shared by all variants.
    defines?: { [key: string]: string | number },
    includes?: string[],
    variants: ShaderVariantConfigVariant[],
}
export interface ShaderVariantConfigMultiple {
    files: ShaderVariantConfigFile[],
}
export type ShaderVariantConfig = ShaderVariantConfigFile | ShaderVariantConfigMultiple;

function validateConfigVariants(variants: any, context: string): void {
    if (!Array.isArray(variants)) {
        throw new Error(`${context} must have a 'variants' array.`);
    }
    for (let i = 0; i < variants.length; i++) {
        let variant = variants[i];
        if (typeof variant !== 'object' || variant === null || typeof variant.entryPoint !== 'string' || variant.entryPoint.length === 0) {
            throw new Error(`${context} variant #${i} must have a non-empty string 'entryPoint'.`);
        }
    }
}

// Parse & validate a shader variant config file content (JSON). Throws Error on invalid input.
export function parseShaderVariantConfig(text: string): ShaderVariantConfig {
    let parsed: any;
    try {
        parsed = JSON.parse(text);
    } catch (e) {
        throw new Error(`Invalid JSON: ${e instanceof Error ? e.message : e}`);
    }
    if (typeof parsed !== 'object' || parsed === null) {
        throw new Error("Expected a JSON object with a 'variants' or 'files' field.");
    }
    if (Array.isArray(parsed.files)) {
        parsed.files.forEach((file: any, i: number) => validateConfigVariants(file?.variants, `'files' entry #${i}`));
        return parsed as ShaderVariantConfigMultiple;
    }
    if (Array.isArray(parsed.variants)) {
        validateConfigVariants(parsed.variants, "config");
        return parsed as ShaderVariantConfigFile;
    }
    throw new Error("Expected a 'variants' array (single-file form) or a 'files' array (multi-file form).");
}

// Base name (file name without folder) of a path using forward or back slashes.
function getBaseName(p: string): string {
    let normalized = p.replace(/\\/g, '/');
    let lastSlash = normalized.lastIndexOf('/');
    return lastSlash >= 0 ? normalized.substring(lastSlash + 1) : normalized;
}

// Map a config stage string to the ShaderStage enum. Unknown / null / undefined => auto.
function stageFromString(stage: string | null | undefined): ShaderStage {
    if (stage === null || stage === undefined) {
        return ShaderStage.auto;
    }
    let value = ShaderStage[stage as keyof typeof ShaderStage];
    return (typeof value === 'number') ? value : ShaderStage.auto;
}

// Convert a parsed config into a list of ShaderVariant attached to the given uri. All imported
// variants start inactive. openedBaseName (file name with extension) selects the matching entry
// in the multi-file form.
export function configToVariants(uri: vscode.Uri, config: ShaderVariantConfig, openedBaseName: string): ShaderVariant[] {
    let fileConfig: ShaderVariantConfigFile | undefined;
    let files = (config as ShaderVariantConfigMultiple).files;
    if (Array.isArray(files)) {
        fileConfig = files.find(f => f.file !== undefined && getBaseName(f.file) === openedBaseName);
        if (!fileConfig && files.length === 1) {
            fileConfig = files[0];
        }
    } else {
        fileConfig = config as ShaderVariantConfigFile;
    }
    if (!fileConfig || !Array.isArray(fileConfig.variants)) {
        return [];
    }
    // File-level common defines/includes are applied to every variant; a variant's own values
    // take precedence over the common ones on key (define) or path (include) conflict.
    let commonDefines = fileConfig.defines || {};
    let commonIncludes = fileConfig.includes || [];
    return fileConfig.variants.map((variant: ShaderVariantConfigVariant): ShaderVariant => {
        // Merge defines: common first, then the variant's own (variant overrides on key conflict).
        let mergedDefines = new Map<string, string>();
        for (let [label, value] of Object.entries(commonDefines)) {
            mergedDefines.set(label, String(value));
        }
        if (variant.defines) {
            for (let [label, value] of Object.entries(variant.defines)) {
                mergedDefines.set(label, String(value));
            }
        }
        let defines: ShaderVariantDefine[] = Array.from(mergedDefines, ([label, value]): ShaderVariantDefine => {
            return { kind: 'define', label: label, value: value };
        });
        // Merge includes: common then variant, de-duplicated while preserving order.
        let seenIncludes = new Set<string>();
        let includes: ShaderVariantInclude[] = [];
        for (let include of [...commonIncludes, ...(variant.includes || [])]) {
            if (!seenIncludes.has(include)) {
                seenIncludes.add(include);
                includes.push({ kind: 'include', include: include });
            }
        }
        return {
            kind: 'variant',
            uri: uri,
            name: variant.entryPoint,
            custom: typeof variant.custom === 'string' && variant.custom.length > 0 ? variant.custom : undefined,
            isActive: false,
            stage: { kind: 'stage', stage: stageFromString(variant.stage) },
            defines: { kind: 'defineList', defines: defines },
            includes: { kind: 'includeList', includes: includes },
        };
    });
}

// Stable identity of a variant including its defines & includes. Needed because several variants
// of the same shader often share entry point & stage and differ only by their defines (e.g. UE
// permutations), so name+stage alone cannot tell them apart.
export function variantSignature(variant: ShaderVariant): string {
    return JSON.stringify({
        name: variant.name,
        custom: variant.custom ?? null,
        stage: variant.stage.stage,
        defines: variant.defines.defines.map(d => [d.label, d.value]),
        includes: variant.includes.includes.map(i => i.include),
    });
}

// Merge several parsed configs into one de-duplicated variant list for the opened shader. Used to
// fold the many single-permutation JSON files an engine dumps (one per entry point x permutation)
// into a single set. Single-file configs whose 'file' targets a different shader are skipped;
// multi-file configs are matched by openedBaseName inside configToVariants. Identical permutations
// (same variantSignature) are collapsed.
export function mergeVariantConfigs(uri: vscode.Uri, configs: ShaderVariantConfig[], openedBaseName: string): ShaderVariant[] {
    let merged: ShaderVariant[] = [];
    let seen = new Set<string>();
    for (let config of configs) {
        let isMultiFile = Array.isArray((config as ShaderVariantConfigMultiple).files);
        if (!isMultiFile) {
            let file = (config as ShaderVariantConfigFile).file;
            if (file && getBaseName(file).toLowerCase() !== openedBaseName.toLowerCase()) {
                continue; // single-file config describing a different shader
            }
        }
        for (let variant of configToVariants(uri, config, openedBaseName)) {
            let signature = variantSignature(variant);
            if (!seen.has(signature)) {
                seen.add(signature);
                merged.push(variant);
            }
        }
    }
    return merged;
}

// Plain (testable) grouping of a file's permutations by entry point. Permutations sharing an entry
// point + stage are grouped; `commonDefines` are the (label,value) pairs identical across ALL of
// them, `includes` the includes shared by all, and each permutation's `deltaDefines` are the defines
// that differ from the common set. First-seen order is preserved.
export type EntryGroupData = {
    name: string,
    stage: ShaderStage,
    commonDefines: { label: string, value: string }[],
    includes: string[],
    permutations: { variant: ShaderVariant, deltaDefines: { label: string, value: string }[] }[],
};
export function groupVariantsByEntryPoint(variants: ShaderVariant[]): EntryGroupData[] {
    let order: string[] = [];
    let groups = new Map<string, ShaderVariant[]>();
    for (let variant of variants) {
        let key = `${variant.name} ${variant.stage.stage}`;
        let bucket = groups.get(key);
        if (!bucket) { bucket = []; groups.set(key, bucket); order.push(key); }
        bucket.push(variant);
    }
    return order.map((key): EntryGroupData => {
        let permutations = groups.get(key)!;
        // Common defines: label present with identical value in every permutation.
        let common = new Map<string, string>(permutations[0].defines.defines.map(d => [d.label, d.value]));
        for (let i = 1; i < permutations.length; i++) {
            let m = new Map(permutations[i].defines.defines.map(d => [d.label, d.value]));
            for (let [label, value] of [...common]) {
                if (m.get(label) !== value) { common.delete(label); }
            }
        }
        // Common includes: present in every permutation.
        let commonIncludes: Set<string> | null = null;
        for (let permutation of permutations) {
            let set = new Set(permutation.includes.includes.map(i => i.include));
            if (commonIncludes === null) { commonIncludes = set; }
            else { for (let include of [...commonIncludes]) { if (!set.has(include)) { commonIncludes.delete(include); } } }
        }
        // Union of all define keys across all permutations — needed for the `_` (undefined) value.
        const allKeys = new Set<string>();
        for (const variant of permutations) {
            for (const d of variant.defines.defines) {
                if (!common.has(d.label)) { allKeys.add(d.label); }
            }
        }
        return {
            name: permutations[0].name,
            stage: permutations[0].stage.stage,
            commonDefines: [...common].map(([label, value]) => ({ label, value })),
            includes: commonIncludes ? [...commonIncludes] : [],
            permutations: permutations.map(variant => {
                const variantKeys = new Set(variant.defines.defines.map(d => d.label));
                const delta: { label: string, value: string }[] = variant.defines.defines
                    .filter(d => common.get(d.label) !== d.value)
                    .map(d => ({ label: d.label, value: d.value }));
                // For every varying key absent from this variant, add `key=_` (undefined).
                for (const key of allKeys) {
                    if (!variantKeys.has(key)) {
                        delta.push({ label: key, value: '_' });
                    }
                }
                return { variant, deltaDefines: delta };
            }),
        };
    });
}

// Build the vary-defines projection for a single entry group. Returns null when there are no
// varying keys (single-permutation group), so the caller can hide the varyingDefineList node.
function buildVaryingDefines(group: EntryGroupData, selectionKey: string): ShaderVaryingDefineList | null {
    const keyToValues = new Map<string, Set<string>>();
    for (const perm of group.permutations) {
        for (const d of perm.deltaDefines) {
            let values = keyToValues.get(d.label);
            if (!values) { values = new Set<string>(); keyToValues.set(d.label, values); }
            values.add(d.value);
        }
    }
    if (keyToValues.size === 0) {
        return null;
    }
    const defines: ShaderVaryingDefine[] = [];
    for (const [key, values] of keyToValues) {
        const isFlat = values.size <= 2;
        const valueNodes: ShaderVaryingDefineValue[] = [...values].sort().map(v => ({
            kind: 'varyingDefineValue' as const,
            label: v,
            defineKey: key,
            selectionKey,
            flat: isFlat,
        }));
        defines.push({
            kind: 'varyingDefine' as const,
            label: key,
            selectionKey,
            values: valueNodes,
        });
    }
    defines.sort((a, b) => a.label.localeCompare(b.label));
    return { kind: 'varyingDefineList', selectionKey, defines };
}

const shaderVariantTreeKey : string = 'shader-validator.shader-variant-tree-key';

export class ShaderVariantTreeDataProvider implements vscode.TreeDataProvider<ShaderVariantNode> {

    private onDidChangeTreeDataEmitter: vscode.EventEmitter<ShaderVariantNode | undefined | void> = new vscode.EventEmitter<ShaderVariantNode | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<ShaderVariantNode | undefined | void> = this.onDidChangeTreeDataEmitter.event;

    // using vscode.Uri as key does not match well with Memento state storage...
    private files: Map<string, ShaderVariantFile>;
    private tree: vscode.TreeView<ShaderVariantNode>;
    private server: ShaderLanguageClient;
    private decorator: Map<string, vscode.TextEditorDecorationType>;
    private workspaceState: vscode.Memento;
    private shaderEntryPointList: Map<string, ShaderEntryPoint[]>;
    private asyncGoToShaderEntryPoint: Map<vscode.Uri, string>;
    private lastSentShaderVariant: ShaderVariantSerialized | null = null;
    private lastSentShaderVariantUri: vscode.Uri | null = null;
    private shaderVariantNotificationQueue: Promise<void> = Promise.resolve();
    // Cached recursive listing of *.json files under the resolved variantFolder (rebuilt on open &
    // when the setting changes; reused while switching variants to avoid re-walking the tree).
    private jsonFileCache: { root: string, files: vscode.Uri[] } | null = null;
    // Cached per-file grouped projection (entry-point groups) shown in the panel. Stable object
    // identity preserves tree expansion/checkbox state; invalidated only when a file's variants
    // change (membership/defines), not on a plain active toggle. Built lazily by getChildren.
    private groupCache: Map<string, ShaderEntryGroup[]> = new Map();
    // Per-entry-group varying define selection: "${filePath}::${entryGroupName}" → Map<defineKey, selectedValue>.
    // Updated on permutation checkbox / varyingDefineValue checkbox changes, or initialized from the
    // active permutation when groups are built.  Keyed by string so it survives groupCache invalidation.
    private varyingSelection: Map<string, Map<string, string>> = new Map();
    // Toggle between flat file list and directory-tree view.
    private treeMode: boolean = false;
    // Cached directory tree (rebuilt when files change or treeMode toggles).
    private dirCache: Map<string, ShaderDirectoryNode> = new Map();
    private dirTreeRoots: ShaderVariantNode[] | null = null;

    private inferShaderLanguageId(uri: vscode.Uri): string | null {
        const path = uri.path.toLowerCase();
        if (path.endsWith('.hlsl') || path.endsWith('.hlsli') || path.endsWith('.fx') || path.endsWith('.fxh')
            || path.endsWith('.ush') || path.endsWith('.usf')) {
            return 'hlsl';
        }
        if (path.endsWith('.glsl') || path.endsWith('.vert') || path.endsWith('.frag') || path.endsWith('.mesh')
            || path.endsWith('.task') || path.endsWith('.comp') || path.endsWith('.geom')
            || path.endsWith('.tesc') || path.endsWith('.tese')) {
            return 'glsl';
        }
        if (path.endsWith('.wgsl')) {
            return 'wgsl';
        }
        return null;
    }
    private canManageShaderDocument(document: vscode.TextDocument | undefined): document is vscode.TextDocument {
        if (!document || document.uri.scheme !== 'file') {
            return false;
        }
        if (ShaderLanguageClient.isEnabledLangId(document.languageId)) {
            return true;
        }
        const inferred = this.inferShaderLanguageId(document.uri);
        return inferred !== null && ShaderLanguageClient.isEnabledLangId(inferred);
    }

    private load() {
        let variants : ShaderVariantFile[] = this.workspaceState.get<ShaderVariantFile[]>(shaderVariantTreeKey, []);
        this.files = new Map(variants.map((e : ShaderVariantFile) => {
            // Seems that serialisation is breaking something, so this is required for uri & range to behave correctly.
            e.uri = vscode.Uri.from(e.uri);
            for (let variant of e.variants) {
                variant.uri = vscode.Uri.from(variant.uri);
            }
            return [e.uri.path, e];
        }));
    }
    private save() {
        let array = Array.from(this.files.values());
        this.workspaceState.update(shaderVariantTreeKey, array);
    }

    constructor(context: vscode.ExtensionContext, server: ShaderLanguageClient) {
        this.workspaceState = context.workspaceState;
        this.files = new Map;
        this.load();
        this.shaderEntryPointList = new Map;
        this.server = server;
        this.tree = vscode.window.createTreeView<ShaderVariantNode>("shader-validator-variants", {
            treeDataProvider: this
            // TODO: drag and drop for better ux.
            //dragAndDropController:
        });
        this.asyncGoToShaderEntryPoint = new Map;
        this.tree.onDidChangeCheckboxState(async (e: vscode.TreeCheckboxChangeEvent<ShaderVariantNode>) => {
            let varyingToggled = false;
            let permutationActivated = false;
            for (let [node, checkboxState] of e.items) {
                if (node.kind === 'permutation') {
                    let variant = node.variant;
                    if (checkboxState === vscode.TreeItemCheckboxState.Checked) {
                        this.syncVaryingSelectionFromVariant(variant);
                        await this.activateVariantWithRefresh(variant);
                        // After reload may have invalidated groupCache; sync again defensively.
                        this.syncVaryingSelectionFromVariant(variant);
                        permutationActivated = true;
                    } else {
                        // Deactivation is handled by activateVariantWithRefresh when a different
                        // permutation is checked in the same batch.  For a pure uncheck (no new
                        // active), the end-of-handler refresh picks it up.
                        variant.isActive = false;
                    }
                } else if (node.kind === 'varyingDefineValue') {
                    varyingToggled = true;
                    if (checkboxState === vscode.TreeItemCheckboxState.Checked) {
                        // Radio behaviour falls out naturally: setting the same key in the Map
                        // overwrites the previous value; getTreeItem reads the new value and
                        // renders the sibling unchecked on the next refresh.
                        let sel = this.varyingSelection.get(node.selectionKey);
                        if (!sel) {
                            sel = new Map<string, string>();
                            this.varyingSelection.set(node.selectionKey, sel);
                        }
                        sel.set(node.defineKey, node.label);

                        // If every varying key now has a value, try to match a permutation.
                        const ownerGroup = this.lookupEntryGroup(node.selectionKey);
                        if (ownerGroup) {
                            const allVaryingKeys = ownerGroup.varyingDefineList.defines.map(d => d.label);
                            if (allVaryingKeys.every(k => sel!.has(k))) {
                                const match = this.findMatchingPermutation(ownerGroup, sel);
                                if (match) {
                                    this.syncVaryingSelectionFromVariant(match.variant);
                                    await this.activateVariantWithRefresh(match.variant);
                                } else {
                                    // Invalid combination: still re-parse with selected defines.
                                    this.notifyVaryingSelection(node.selectionKey, sel);
                                }
                            } else {
                                // Incomplete: notify with partial selection so the server
                                // re-parses using whatever varying defines the user has picked.
                                this.notifyVaryingSelection(node.selectionKey, sel);
                            }
                        }
                    } else {
                        // Unchecked: remove this key from the selection.
                        const sel = this.varyingSelection.get(node.selectionKey);
                        if (sel) {
                            sel.delete(node.defineKey);
                            if (sel.size === 0) {
                                this.varyingSelection.delete(node.selectionKey);
                                // No keys left: notify the server with only common defines.
                                this.notifyVaryingClear(node.selectionKey);
                            } else {
                                // Remaining partial selection: keep the server current.
                                this.notifyVaryingSelection(node.selectionKey, sel);
                            }
                        }
                    }
                    // Re-render checkbox / label state without re-sending the active permutation,
                    // otherwise it would overwrite the custom varying-define notification we just sent.
                    this.refreshTreeOnly();
                }
            }
            // notifyVariantChanged would send the globally-active permutation or null — but when
            // varying defines were toggled the varying-selection helpers above already sent the
            // right defines (including synthetic ones for invalid/incomplete combinations).
            if (!varyingToggled) {
                if (!permutationActivated) {
                    // Pure uncheck (no new permutation selected): refresh the tree and notify the
                    // server so it re-parses with base defines.
                    this.refreshAll();
                }
                this.notifyVariantChanged();
            }
            this.save();
            this.updateDecorations();
        });
        this.decorator = new Map;
        const supportedLangIds = ShaderLanguageClient.getSupportedLangId();
        for (var supportedLangId of supportedLangIds) {
            this.decorator.set(supportedLangId, vscode.window.createTextEditorDecorationType({
                // Icon
                gutterIconPath: context.asAbsolutePath(`./res/icons/${supportedLangId}-icon.svg`),
                gutterIconSize: "contain",
                // Minimap
                overviewRulerColor: "rgb(0, 174, 255)",
                overviewRulerLane: vscode.OverviewRulerLane.Full,
                rangeBehavior: vscode.DecorationRangeBehavior.OpenOpen,
                // Border
                borderWidth: '1px',
                borderStyle: 'solid',
            }));
        }
        context.subscriptions.push(vscode.commands.registerCommand("shader-validator.addCurrentFile", async (): Promise<void> => {
            const document = vscode.window.activeTextEditor?.document;
            if (!this.canManageShaderDocument(document)) {
                vscode.window.showWarningMessage("Add Current File requires an open local shader file (.usf/.ush/.hlsl/.glsl/.wgsl).");
                return;
            }
            const uri = document.uri;
            const existingFile = this.files.get(uri.path);
            if (existingFile) {
                this.revealFile(existingFile);
                return;
            }
            const importedCount = await this.importVariantsFromConfig(uri, true);
            if (importedCount === 0) {
                this.open(uri);
            }
            const file = this.files.get(uri.path);
            if (file) {
                this.revealFile(file);
            }
            this.save();
        }));
        context.subscriptions.push(vscode.commands.registerCommand("shader-validator.addCurrentFileVariant", async () => {
            const document = vscode.window.activeTextEditor?.document;
            if (!this.canManageShaderDocument(document)) {
                vscode.window.showWarningMessage("Add Current File Variant requires an open local shader file (.usf/.ush/.hlsl/.glsl/.wgsl).");
                return;
            }
            let entryPoint = await this.promptEntryPoint();
            if (entryPoint) {
                let stage = await this.promptShaderStage();
                if (stage) {
                    let uri = document.uri;
                    this.openOrAddVariant(uri, {
                        kind: 'variant',
                        uri: uri,
                        name: entryPoint,
                        isActive: true,
                        stage: {
                            kind: 'stage',
                            stage: stage
                        },
                        defines: {
                            kind: 'defineList',
                            defines:[]
                        },
                        includes: {
                            kind: 'includeList',
                            includes:[]
                        },
                    });
                    }
                }
            this.save();
        }));
        context.subscriptions.push(vscode.commands.registerCommand("shader-validator.addMenu", async (node: ShaderVariantNode) => {
            await this.add(node);
            this.save();
        }));
        context.subscriptions.push(vscode.commands.registerCommand("shader-validator.deleteMenu", (node: ShaderVariantNode) => {
            this.delete(node);
            this.save();
        }));
        // Manual "Refresh" button — re-reads variant JSON configs from disk for the given file
        // (or the active editor's file when invoked from the view title bar).
        context.subscriptions.push(vscode.commands.registerCommand(
            "shader-validator.refreshVariants",
            async (node?: ShaderVariantNode) => {
                let uri: vscode.Uri | undefined;
                if (node && node.kind === 'file') {
                    uri = node.uri;
                } else if (vscode.window.activeTextEditor) {
                    uri = vscode.window.activeTextEditor.document.uri;
                }
                if (uri) {
                    await this.importVariantsFromConfig(uri, true);
                }
            }
        ));
        context.subscriptions.push(vscode.commands.registerCommand(
            "shader-validator.toggleTreeView",
            () => {
                this.treeMode = !this.treeMode;
                this.dirTreeRoots = null;
                this.onDidChangeTreeDataEmitter.fire();
            }
        ));
        context.subscriptions.push(vscode.commands.registerCommand(
            "shader-validator.copyDefineName",
            async (node?: ShaderVariantNode) => {
                const text = node ? this.getCopySearchText(node) : undefined;
                if (text) {
                    await vscode.env.clipboard.writeText(text);
                }
            }
        ));
        context.subscriptions.push(vscode.commands.registerCommand(
            "shader-validator.searchDefineName",
            async (node?: ShaderVariantNode) => {
                if (!node) {
                    return;
                }
                const text = this.getCopySearchText(node);
                const uri = this.resolveShaderFileUri(node);
                if (!text || !uri) {
                    return;
                }
                await this.jumpToFirstMatch(uri, text);
            }
        ));
        context.subscriptions.push(vscode.commands.registerCommand("shader-validator.editMenu", async (node: ShaderVariantNode) => {
            await this.edit(node);
            this.save();
        }));
        context.subscriptions.push(vscode.commands.registerCommand("shader-validator.gotoShaderEntryPoint", (uri: vscode.Uri, entryPointName: string) => {
            // sometimes, its goes in random place in file...
            // TODO: Should use regex & read diag region instead.
            let diagnostic = vscode.languages.getDiagnostics().find(([diagUri, diags]) => diagUri === uri);

            this.goToShaderEntryPoint(uri, entryPointName, true);
        }));
        // Prepare entry point symbol cache
        for (let editor of vscode.window.visibleTextEditors) {
            if (editor.document.uri.scheme === 'file') {
                this.shaderEntryPointList.set(editor.document.uri.path, []);
            }
        }
        context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(document => {
            if (document.uri.scheme === 'file') {
                this.shaderEntryPointList.set(document.uri.path, []);
            }
        }));
        // Setting changes only invalidate the cached JSON file listing. Variant data is refreshed
        // explicitly via the Refresh command or when the user clicks Add File.
        context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration("shader-validator.variantFolder")) {
                this.jsonFileCache = null;
            }
        }));
        context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(document => {
            this.shaderEntryPointList.delete(document.uri.path);
        }));
        context.subscriptions.push(vscode.workspace.onDidRenameFiles(document => {
            for (const fileObj of document.files) {
                const { oldUri, newUri } = fileObj;
                // To update the key in a Map, you need to remove the old key and add the new one.
                const oldPath = oldUri.path;
                const newPath = newUri.path;
                const file = this.files.get(oldPath);
                if (file) {
                    // Update the uri inside the file object
                    file.uri = newUri;
                    // Remove the old key and set the new key
                    this.files.delete(oldPath);
                    this.files.set(newPath, file);
                    this.invalidateGroups(oldPath);
                    this.invalidateGroups(newPath);
                }
                // Also update entry point and async maps
                const entryPoints = this.shaderEntryPointList.get(oldPath);
                if (entryPoints) {
                    this.shaderEntryPointList.delete(oldPath);
                    this.shaderEntryPointList.set(newPath, entryPoints);
                }
                const asyncEntryPoint = this.asyncGoToShaderEntryPoint.get(oldUri);
                if (asyncEntryPoint) {
                    this.asyncGoToShaderEntryPoint.delete(oldUri);
                    this.asyncGoToShaderEntryPoint.set(newUri, asyncEntryPoint);
                }
                this.shaderEntryPointList;
                this.asyncGoToShaderEntryPoint;
            }
        }));
        // Auto-reveal the panel node for the active shader when switching/opening editors.
        context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => this.revealActiveEditorFile(editor)));
        this.revealActiveEditorFile(vscode.window.activeTextEditor);
        this.onServerStart();
    }
    onServerStart() {
        this.updateDependencies();
    }
    dispose() {
        // Nothing to do here.
    }
    private getActiveVariant() : ShaderVariant | null {
        for (const file of this.files.values()) {
            const activeVariant = file.variants.find((e: ShaderVariant) => e.isActive);
            if (activeVariant) {
                return activeVariant;
            }
        }
        return null;
    }
    private hasActiveVariant(file: ShaderVariantFile) : ShaderVariant | null {
        const activeVariant = file.variants.find((e: ShaderVariant) => e.isActive);
        if (activeVariant) {
            return activeVariant;
        }
        return null;
    }

    private goToShaderEntryPoint(uri: vscode.Uri, entryPointName: string, defer: boolean) {
        let shaderEntryPointList = this.shaderEntryPointList.get(uri.path);
        let entryPoint = shaderEntryPointList?.find(e => e.entryPoint === entryPointName);
        // TOOD: Could instead regex + check regions via vscode.
        if (entryPoint) {
            vscode.commands.executeCommand('vscode.open', uri, <vscode.TextDocumentShowOptions>{
                selection: entryPoint.range
            });
        } else {
            let editor = vscode.window.visibleTextEditors.find(e => e.document.uri === uri);
            if (editor || !defer) {
                // Already opened, but no entry point found.
                vscode.window.showWarningMessage(`Failed to find entry point ${entryPointName} for file ${vscode.workspace.asRelativePath(uri)}`);
            } else {
                // Store request & open the file. Resolve goto on document request
                this.asyncGoToShaderEntryPoint.set(uri, entryPointName);
                vscode.commands.executeCommand('vscode.open', uri, <vscode.TextDocumentShowOptions>{});
            }
        }
    }

    private getFileAndParentNode(node: ShaderVariantNode) : [ShaderVariantFile, ShaderVariantNode | null] | null {
        if (node.kind === 'variant') {
            let file = this.files.get(node.uri.path);
            if (file) {
                return [file, null]; // No parent
            }
        } else if (node.kind === 'define') {
            for (let [_, file] of this.files) {
                for (let variant of file.variants) {
                    let index = variant.defines.defines.indexOf(node);
                    if (index > -1) {
                        return [file, variant.defines];
                    }
                }
            }
        } else if (node.kind === 'defineList') {
            for (let [_, file] of this.files) {
                for (let variant of file.variants) {
                    if (variant.defines === node) {
                        return [file, variant];
                    }
                }
            }
        } else if (node.kind === 'stage') {
            for (let [_, file] of this.files) {
                for (let variant of file.variants) {
                    if (variant.stage === node) {
                        return [file, variant];
                    }
                }
            }
        } else if (node.kind === 'include') {
            for (let [_, file] of this.files) {
                for (let variant of file.variants) {
                    let index = variant.includes.includes.indexOf(node);
                    if (index > -1) {
                        return [file, variant.includes];
                    }
                }
            }
        } else if (node.kind === 'includeList') {
            for (let [_, file] of this.files) {
                for (let variant of file.variants) {
                    if (variant.includes === node) {
                        return [file, variant];
                    }
                }
            }
        }
        console.warn("Failed to find file for node ", node);
        return null;
    }

    public refresh(node: ShaderVariantNode | null, file: ShaderVariantFile | null) {
        this.onDidChangeTreeDataEmitter.fire();
        if (file) {
            this.updateDependency(file);
        } else if (node) {
            let result = this.getFileAndParentNode(node);
            if (result) {
                let [file, parent] = result;
                this.updateDependency(file);
            } else {
                // Something failed here...
                this.updateDependencies();
            }
        }
    }
    public refreshAll() {
        this.onDidChangeTreeDataEmitter.fire();
        this.updateDependencies();
    }
    private refreshTreeOnly() {
        this.onDidChangeTreeDataEmitter.fire();
    }
    private withShaderAnalysisProgress<T>(uri: vscode.Uri | undefined, work: () => Promise<T>): Promise<T> {
        if (!uri) {
            return work();
        }
        return Promise.resolve(vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Window,
                title: `Analyzing shader files: 1/1 ${getBaseName(uri.path)}`,
            },
            async () => await work(),
        ));
    }
    private sendShaderVariantNotification(shaderVariant: ShaderVariantSerialized | null, symbolUri?: vscode.Uri, forceReset: boolean = false) {
        const previous = this.lastSentShaderVariant;
        // Fire a null→real handshake when switching between two non-null variants so the server
        // detects the define-set change and re-resolves.  No delay is necessary — the two LSP
        // messages are ordered; the server processes null (clear) then the new variant (re-parse).
        const shouldForceTransition = forceReset || (previous !== null
            && shaderVariant !== null
            && JSON.stringify(previous) !== JSON.stringify(shaderVariant));
        this.lastSentShaderVariant = shaderVariant;
        this.lastSentShaderVariantUri = symbolUri ?? null;
        this.shaderVariantNotificationQueue = this.shaderVariantNotificationQueue
            .then(async () => {
                if (shouldForceTransition) {
                    await this.server.sendNotification(didChangeShaderVariantNotification, {
                        shaderVariant: null,
                    });
                }
                await this.server.sendNotification(didChangeShaderVariantNotification, {
                    shaderVariant,
                });
                if (symbolUri) {
                    // Send a synthetic textDocument/didChange with the full file content to force
                    // the server to re-parse.  didChangeShaderVariant alone updates the defines on
                    // the server side, but many servers only re-parse on an actual document-change
                    // event.  We send the full text through the LSP channel directly — no editor
                    // edit, no dirty file.
                    const doc = vscode.workspace.textDocuments.find(d => d.uri.path === symbolUri.path);
                    if (doc) {
                        await this.server.sendNotification(DidChangeTextDocumentNotification.type, {
                            textDocument: {
                                uri: this.server.uriAsString(symbolUri),
                                version: doc.version,
                            },
                            contentChanges: [{ text: doc.getText() }],
                        });
                    }
                    await this.requestDocumentSymbol(symbolUri);
                }
            })
            .catch(error => {
                console.warn("Failed to send shader variant notification", error);
            });
    }
    private getEffectiveDefinesForVariant(variant: ShaderVariant): { [key: string]: string } {
        // Start with global shader-validator.defines as a base; the variant's own defines
        // overlay on top and always win on conflict.
        const globalDefines: { [key: string]: string } =
            vscode.workspace.getConfiguration("shader-validator").get<{ [key: string]: string }>("defines") ?? {};
        const fullDefines: { [key: string]: string } = { ...globalDefines };
        const groups = this.groupCache.get(variant.uri.path);
        if (groups) {
            for (const group of groups) {
                for (const perm of group.permutationList.permutations) {
                    if (perm.variant === variant) {
                        for (const d of group.commonDefineList.defines) {
                            if (d.value !== '_') { fullDefines[d.label] = d.value; }
                        }
                        for (const d of perm.deltaDefines) {
                            if (d.value !== '_') { fullDefines[d.label] = d.value; }
                        }
                        return fullDefines;
                    }
                }
            }
        }
        // Fallback: overlay the raw variant defines on top of global.
        for (const d of variant.defines.defines) {
            if (d.value !== '_') { fullDefines[d.label] = d.value; }
        }
        return fullDefines;
    }
    private notifyVariantChanged() {
        function capitalizeFirstLetter(str: string): string {
            return str.charAt(0).toUpperCase() + str.slice(1);
        }
        // Notify server of change.
        let fileActiveVariant = this.getActiveVariant();
        if (fileActiveVariant) {
            const activeVariant = fileActiveVariant;
            // Open document to get language ID.
            // This does not open the document in the editor, only internally.
            vscode.workspace.openTextDocument(activeVariant.uri).then(doc => {
                this.sendShaderVariantNotification(
                    shaderVariantToSerialized(
                        this.server.uriAsString(activeVariant.uri),
                        capitalizeFirstLetter(doc.languageId), // Server expect it with capitalized first letter.
                        activeVariant,
                        this.getEffectiveDefinesForVariant(activeVariant)
                    ),
                    activeVariant.uri,
                );
            });
        } else {
            this.sendShaderVariantNotification(null);
        }

    }
    private requestDocumentSymbol(uri: vscode.Uri): Promise<void> {
        // TODO: should request inlay hint aswell.
        // Previously this used a dirty edit hack (delete + re-insert the last char of the
        // first non-empty line) to force VS Code to re-request document symbols — but that
        // hack marks the file as dirty.  Instead we send a direct LSP documentSymbol request
        // (which the server handles correctly) and update only the extension's internal
        // entry-point cache.  VS Code's built-in outline / breadcrumbs stay stale until the
        // next user edit, but the extension's own features (goto entry point, decorations)
        // work immediately.
        // See https://github.com/microsoft/vscode/issues/108722

        let updateSymbolsOnVariantUpdate = vscode.workspace.getConfiguration("shader-validator").get<boolean>("updateSymbolsOnVariantUpdate");
        if (updateSymbolsOnVariantUpdate) {
            return this.withShaderAnalysisProgress(uri, async () => {
                const result = await this.server.sendRequest(DocumentSymbolRequest.type, {
                    textDocument: {
                        uri: this.server.uriAsString(uri),
                    }
                });
                if (result) {
                    this.onDocumentSymbols(uri, result as vscode.DocumentSymbol[]);
                }
            });
        }
        return Promise.resolve();
    }
    private updateDependency(file: ShaderVariantFile) {
        // When editing variant, might need to send it if holding an active one.
        if (this.hasActiveVariant(file))  {
            this.notifyVariantChanged();
            // sendShaderVariantNotification will queue the null→real handshake,
            // a synthetic didChange, and a documentSymbol request — no need to
            // request symbols here (it would race ahead with stale defines).
        } else {
            this.requestDocumentSymbol(file.uri);
        }
    }
    public onDocumentSymbols(uri: vscode.Uri, symbols: vscode.DocumentSymbol[]) {
        // TODO:TREE: need to recurse child as well.
        this.shaderEntryPointList.set(uri.path, symbols.filter(symbol => symbol.kind === vscode.SymbolKind.Function).map(symbol => {
            return {
                entryPoint: symbol.name, 
                range: symbol.selectionRange
            };
        }));
        // Solve async request for goto.
        let entryPoint = this.asyncGoToShaderEntryPoint.get(uri);
        if (entryPoint) {
            this.asyncGoToShaderEntryPoint.delete(uri);
            this.goToShaderEntryPoint(uri, entryPoint, false);
        }
        this.updateDecorations();
    }
    private updateDependencies() {
        for (let [_, file] of this.files) {
            this.updateDependency(file);
        }
    }

    public getTreeItem(element: ShaderVariantNode): vscode.TreeItem {
        if (element.kind === 'variant') {
            let item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.Collapsed);
            // Need to use a middleware command because item is not updated on collapse change.
            item.command = {
                title: "Go to variant",
                command: 'shader-validator.gotoShaderEntryPoint',
                arguments: [
                    element.uri,
                    element.name
                ]
            };
            item.description = `[${element.defines.defines.map(d => d.label).join(",")}]`;
            item.tooltip = `Shader variant ${element.name}`;
            item.checkboxState = element.isActive ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
            item.contextValue = element.kind;
            return item;
        } else if (element.kind === 'file') {
            const relPath = vscode.workspace.asRelativePath(element.uri);
            const lastSlash = Math.max(relPath.lastIndexOf('/'), relPath.lastIndexOf('\\'));
            const fileName = lastSlash >= 0 ? relPath.slice(lastSlash + 1) : relPath;
            const dirPath = lastSlash >= 0 ? relPath.slice(0, lastSlash + 1) : '';
            let item = new vscode.TreeItem(fileName, vscode.TreeItemCollapsibleState.Expanded);
            item.description = dirPath ? `${dirPath}  ${element.variants.length}` : `${element.variants.length}`;
            item.resourceUri = element.uri;
            item.tooltip = `File ${element.uri.fsPath}`;
            item.iconPath = vscode.ThemeIcon.File;
            item.contextValue = element.kind;
            return item;
        } else if (element.kind === 'directory') {
            const dir = element as ShaderDirectoryNode;
            const item = new vscode.TreeItem(dir.name, vscode.TreeItemCollapsibleState.Collapsed);
            item.description = `${dir.fileCount}`;
            item.tooltip = dir.relPath;
            item.iconPath = vscode.ThemeIcon.Folder;
            item.contextValue = element.kind;
            return item;
        } else if (element.kind === 'defineList') {
            let item = new vscode.TreeItem("defines", vscode.TreeItemCollapsibleState.Expanded);
            item.description = `${element.defines.length}`;
            item.tooltip = `List of defines`,
            item.iconPath = new vscode.ThemeIcon('keyboard');
            item.contextValue = element.kind;
            return item;
        } else if (element.kind === 'includeList') {
            let item = new vscode.TreeItem("includes", vscode.TreeItemCollapsibleState.Expanded);
            item.description = `${element.includes.length}`;
            item.tooltip = `List of includes`,
            item.iconPath = new vscode.ThemeIcon('files');
            item.contextValue = element.kind;
            return item;
        } else if (element.kind === 'define') {
            let item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
            item.description = element.value;
            item.tooltip = `User defined macro ${element.label} with value ${element.value}`,
            item.contextValue = element.kind;
            return item;
        } else if (element.kind === 'include') {
            let resolvedIncludePath = resolveVSCodeVariables(element.include);
            let item = new vscode.TreeItem(element.include, vscode.TreeItemCollapsibleState.None);
            item.description = resolvedIncludePath;
            item.tooltip = `User include path ${resolvedIncludePath}`,
            item.contextValue = element.kind;
            return item;
        } else if (element.kind === 'stage') {
            let item = new vscode.TreeItem("stage", vscode.TreeItemCollapsibleState.None);
            item.description = ShaderStage[element.stage];
            item.tooltip = "The shader stage of this variant. If auto is selected, the server will try to guess the stage, or use generic one when supported by API.";
            item.iconPath = new vscode.ThemeIcon('code');
            item.contextValue = element.kind;
            return item;
        } else if (element.kind === 'entryGroup') {
            let item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.Collapsed);
            item.command = {
                title: "Go to entry point",
                command: 'shader-validator.gotoShaderEntryPoint',
                arguments: [element.uri, element.name]
            };
            const stageName = ShaderStage[element.stageNode.stage];
            item.description = `${stageName}  ${element.permutationCount}`;
            item.tooltip = `Entry point ${element.name} — ${stageName} (${element.permutationCount} permutation${element.permutationCount === 1 ? '' : 's'})`;
            item.iconPath = new vscode.ThemeIcon('symbol-function');
            item.contextValue = element.kind;
            return item;
        } else if (element.kind === 'groupStage') {
            let item = new vscode.TreeItem("stage", vscode.TreeItemCollapsibleState.None);
            item.description = ShaderStage[element.stage];
            item.tooltip = "The shader stage shared by this entry point's permutations.";
            item.iconPath = new vscode.ThemeIcon('code');
            item.contextValue = element.kind;
            return item;
        } else if (element.kind === 'commonDefineList') {
            let item = new vscode.TreeItem("common defines", vscode.TreeItemCollapsibleState.Collapsed);
            item.description = `${element.defines.length}`;
            item.tooltip = "Defines shared by every permutation of this entry point.";
            item.iconPath = new vscode.ThemeIcon('keyboard');
            item.contextValue = element.kind;
            return item;
        } else if (element.kind === 'groupIncludeList') {
            let item = new vscode.TreeItem("includes", vscode.TreeItemCollapsibleState.Collapsed);
            item.description = `${element.includes.length}`;
            item.tooltip = "Includes shared by every permutation of this entry point.";
            item.iconPath = new vscode.ThemeIcon('files');
            item.contextValue = element.kind;
            return item;
        } else if (element.kind === 'permutationList') {
            let item = new vscode.TreeItem("defines", vscode.TreeItemCollapsibleState.Expanded);
            item.description = `${element.permutations.length}`;
            item.tooltip = "One entry per permutation; tick one to make it the active variant.";
            item.iconPath = new vscode.ThemeIcon('versions');
            item.contextValue = element.kind;
            return item;
        } else if (element.kind === 'permutation') {
            let hasDelta = element.deltaDefines.length > 0;
            let item = new vscode.TreeItem(element.label, hasDelta ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
            item.command = {
                title: "Go to entry point",
                command: 'shader-validator.gotoShaderEntryPoint',
                arguments: [element.variant.uri, element.variant.name]
            };
            item.description = `[${element.deltaDefines.map(d => `${d.label}=${d.value}`).join(",")}]`;
            item.tooltip = `Permutation of ${element.variant.name}. Tick to make it the active variant.`;
            item.checkboxState = element.variant.isActive ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
            item.contextValue = element.kind;
            return item;
        } else if (element.kind === 'readonlyDefine') {
            let item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
            item.description = element.value;
            item.tooltip = `Macro ${element.label} = ${element.value}`;
            item.contextValue = element.kind;
            return item;
        } else if (element.kind === 'readonlyInclude') {
            let resolvedIncludePath = resolveVSCodeVariables(element.include);
            let item = new vscode.TreeItem(element.include, vscode.TreeItemCollapsibleState.None);
            item.description = resolvedIncludePath;
            item.tooltip = `Include path ${resolvedIncludePath}`;
            item.contextValue = element.kind;
            return item;
        } else if (element.kind === 'varyingDefineList') {
            const allVaryingKeys = element.defines.map(d => d.label);
            const selection = this.varyingSelection.get(element.selectionKey);
            const allSelected = selection !== undefined && allVaryingKeys.every(k => selection.has(k));

            let label = 'varying defines';
            let tooltip = 'Define keys that differ across permutations. Select one value per key to target a specific permutation.';

            if (selection && selection.size > 0) {
                const ownerGroup = this.lookupEntryGroup(element.selectionKey);
                if (ownerGroup) {
                    const match = allSelected ? this.findMatchingPermutation(ownerGroup, selection) : null;
                    if (match !== null) {
                        label = `varying defines (#${match.index})`;
                        tooltip = `Varying define selection matches permutation #${match.index}.`;
                    } else if (allSelected) {
                        label = 'varying defines (#invalid)';
                        tooltip = 'No permutation matches this combination of varying define values.';
                    }
                }
            }

            const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
            item.description = `${element.defines.length}`;
            item.tooltip = tooltip;
            item.iconPath = new vscode.ThemeIcon('symbol-boolean');
            item.contextValue = element.kind;
            return item;
        } else if (element.kind === 'varyingDefine') {
            // Collapsible "inline dropdown": description shows the currently-selected value,
            // children are the value checkboxes. Works for any number of values.
            const selection = this.varyingSelection.get(element.selectionKey);
            const current = selection?.get(element.label);
            const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Collapsed);
            item.description = current ?? '';
            item.tooltip = `Varying define "${element.label}" — ${element.values.length} value${element.values.length === 1 ? '' : 's'}.${current ? ` Currently: ${current}` : ''}`;
            item.iconPath = new vscode.ThemeIcon('symbol-key');
            item.contextValue = element.kind;
            return item;
        } else if (element.kind === 'varyingDefineValue') {
            const selection = this.varyingSelection.get(element.selectionKey);
            const isChecked = selection !== undefined && selection.get(element.defineKey) === element.label;

            const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
            item.checkboxState = isChecked
                ? vscode.TreeItemCheckboxState.Checked
                : vscode.TreeItemCheckboxState.Unchecked;
            item.tooltip = `Set "${element.defineKey}" to "${element.label}".`;
            item.contextValue = element.kind;
            return item;
        } else {
            console.error("Unimplemented kind: ", element);
            return undefined!; // unreachable
        }
    }

    public getChildren(element?: ShaderVariantNode): ShaderVariantNode[] | Thenable<ShaderVariantNode[]> {
        if (!element) {
            if (this.treeMode) {
                return this.buildFileTree();
            }
            return Array.from(this.files.values());
        }
        switch (element.kind) {
            case 'directory': return (element as ShaderDirectoryNode).children;
            case 'file': return this.getEntryGroups(element);
            case 'entryGroup': {
                const children: ShaderVariantNode[] = [
                    element.commonDefineList,
                    element.includeList,
                    element.permutationList,
                ];
                // Insert varyingDefineList after commonDefineList when non-empty.
                if (element.varyingDefineList.defines.length > 0) {
                    children.splice(1, 0, element.varyingDefineList);
                }
                return children;
            }
            case 'commonDefineList': return element.defines;
            case 'groupIncludeList': return element.includes;
            case 'permutationList': return element.permutations;
            case 'permutation': return element.deltaDefines;
            case 'varyingDefineList': {
                // One collapsible node per varying key — expands to show value checkboxes inline.
                return element.defines;
            }
            case 'varyingDefine': return element.values;
            case 'varyingDefineValue': return [];
            // Leaf & legacy kinds have no children in the grouped view.
            default: return [];
        }
    }
    // Build (or reuse) a hierarchical directory tree from the flat file map. Returns the root-level
    // directory nodes; files are placed as leaf children under their respective directories.
    private buildFileTree(): ShaderVariantNode[] {
        if (this.dirTreeRoots) { return this.dirTreeRoots; }
        this.dirCache.clear();
        const roots: ShaderVariantNode[] = [];
        const ensureDir = (parts: string[], index: number, relSoFar: string): ShaderDirectoryNode => {
            const key = parts.slice(0, index + 1).join('/');
            let dir = this.dirCache.get(key);
            if (!dir) {
                const name = parts[index];
                dir = { kind: 'directory', name, relPath: key, children: [], fileCount: 0 };
                this.dirCache.set(key, dir);
                if (index === 0) { roots.push(dir); }
                else {
                    const parent = ensureDir(parts, index - 1, parts.slice(0, index).join('/'));
                    if (!parent.children.some(c => c.kind === 'directory' && (c as ShaderDirectoryNode).relPath === key)) {
                        parent.children.push(dir);
                    }
                }
            }
            return dir;
        };
        for (const file of this.files.values()) {
            const relPath = vscode.workspace.asRelativePath(file.uri);
            const parts = relPath.split(/[/\\]/);
            if (parts.length <= 1) {
                // File at workspace root — place directly in root list.
                roots.push(file);
            } else {
                const dirParts = parts.slice(0, -1);
                const dir = ensureDir(dirParts, dirParts.length - 1, '');
                dir.children.push(file);
            }
        }
        // Sort: directories first (by name), then files (by name).
        const sortNodes = (nodes: ShaderVariantNode[]) => {
            nodes.sort((a, b) => {
                const aIsDir = a.kind === 'directory';
                const bIsDir = b.kind === 'directory';
                if (aIsDir !== bIsDir) { return aIsDir ? -1 : 1; }
                const aName = a.kind === 'directory' ? (a as ShaderDirectoryNode).name : (a as ShaderVariantFile).uri.path;
                const bName = b.kind === 'directory' ? (b as ShaderDirectoryNode).name : (b as ShaderVariantFile).uri.path;
                return aName.localeCompare(bName);
            });
        };
        sortNodes(roots);
        for (const dir of this.dirCache.values()) { sortNodes(dir.children); }
        // Compute recursive file counts (post-order).
        for (const dir of this.dirCache.values()) {
            let count = 0;
            for (const child of dir.children) {
                if (child.kind === 'file') { count++; }
                else if (child.kind === 'directory') { count += (child as ShaderDirectoryNode).fileCount; }
            }
            dir.fileCount = count;
        }
        this.dirTreeRoots = roots;
        return roots;
    }
    // Build (or reuse cached) entry-point groups for a file. Cached objects keep stable identity so
    // tree expansion & checkbox state survive refreshes; invalidated on variant-set change.
    private getEntryGroups(file: ShaderVariantFile): ShaderEntryGroup[] {
        let cached = this.groupCache.get(file.uri.path);
        if (cached) {
            return cached;
        }
        let groups = groupVariantsByEntryPoint(file.variants).map((group): ShaderEntryGroup => {
            const selectionKey = `${file.uri.path}::${group.name}`;
            // Seed varyingSelection from the active permutation (only on first build).
            this.initVaryingSelectionFromGroup(group, selectionKey);
            const varyingDefineList = buildVaryingDefines(group, selectionKey)
                || { kind: 'varyingDefineList' as const, selectionKey, defines: [] };

            return {
                kind: 'entryGroup',
                uri: file.uri,
                name: group.name,
                permutationCount: group.permutations.length,
                stageNode: { kind: 'groupStage', stage: group.stage },
                commonDefineList: {
                    kind: 'commonDefineList',
                    defines: group.commonDefines.map((d): ShaderReadonlyDefine => ({ kind: 'readonlyDefine', label: d.label, value: d.value, groupName: group.name })),
                },
                varyingDefineList,
                includeList: {
                    kind: 'groupIncludeList',
                    includes: group.includes.map((i): ShaderReadonlyInclude => ({ kind: 'readonlyInclude', include: i })),
                },
                permutationList: {
                    kind: 'permutationList',
                    permutations: group.permutations.map((p, index): ShaderPermutation => ({
                        kind: 'permutation',
                        variant: p.variant,
                        label: p.variant.custom && p.variant.custom.length > 0 ? `#${index} [${p.variant.custom}]` : `#${index}`,
                        deltaDefines: p.deltaDefines.map((d): ShaderReadonlyDefine => ({ kind: 'readonlyDefine', label: d.label, value: d.value, groupName: group.name })),
                    })),
                },
            };
        });
        this.groupCache.set(file.uri.path, groups);
        return groups;
    }
    private invalidateGroups(filePath: string) {
        this.groupCache.delete(filePath);
        this.varyingSelection.clear();
        this.dirTreeRoots = null;
    }
    // Seed varyingSelection from the active permutation in a group (used on first group build).
    private initVaryingSelectionFromGroup(group: EntryGroupData, selectionKey: string): void {
        if (this.varyingSelection.has(selectionKey)) { return; }
        const activePerm = group.permutations.find(p => p.variant.isActive);
        if (activePerm && activePerm.deltaDefines.length > 0) {
            const sel = new Map<string, string>();
            for (const d of activePerm.deltaDefines) { sel.set(d.label, d.value); }
            this.varyingSelection.set(selectionKey, sel);
        }
    }
    // Force-update varyingSelection to match a variant's delta defines (called on permutation check).
    private syncVaryingSelectionFromVariant(variant: ShaderVariant): void {
        const groups = this.groupCache.get(variant.uri.path);
        if (!groups) { return; }
        for (const group of groups) {
            for (const perm of group.permutationList.permutations) {
                if (perm.variant === variant) {
                    const selectionKey = `${variant.uri.path}::${group.name}`;
                    const sel = new Map<string, string>();
                    for (const d of perm.deltaDefines) { sel.set(d.label, d.value); }
                    this.varyingSelection.set(selectionKey, sel);
                    return;
                }
            }
        }
    }
    // Find whether the current varyingSelection matches a permutation in the given group.
    // Returns { index, variant } on exact match, or null for incomplete / invalid combinations.
    private findMatchingPermutation(
        group: ShaderEntryGroup,
        selection: Map<string, string>,
    ): { index: number; variant: ShaderVariant; } | null {
        for (let i = 0; i < group.permutationList.permutations.length; i++) {
            const perm = group.permutationList.permutations[i];
            // A match requires every selected (key,value) to be present in the permutation's delta,
            // AND the delta must contain only keys in the selection (exact set equality).
            const delta = new Map(perm.deltaDefines.map(d => [d.label, d.value]));
            if (delta.size !== selection.size) { continue; }
            let matches = true;
            for (const [key, value] of selection) {
                if (delta.get(key) !== value) { matches = false; break; }
            }
            if (matches) { return { index: i, variant: perm.variant }; }
        }
        return null;
    }
    // Resolve a selectionKey back to the owning ShaderEntryGroup (if cached).
    private getCopySearchText(node: ShaderVariantNode): string | undefined {
        if (node.kind === 'varyingDefine' || node.kind === 'readonlyDefine') {
            return node.label;
        }
        if (node.kind === 'entryGroup') {
            return node.name;
        }
        return undefined;
    }
    private resolveShaderFileUri(node: ShaderVariantNode): vscode.Uri | undefined {
        if (node.kind === 'entryGroup') {
            return node.uri;
        }
        if (node.kind === 'varyingDefine') {
            return this.lookupEntryGroup(node.selectionKey)?.uri;
        }
        if (node.kind === 'readonlyDefine') {
            let parent: ShaderVariantNode | undefined = this.getParent(node);
            while (parent) {
                if (parent.kind === 'entryGroup') {
                    return parent.uri;
                }
                parent = this.getParent(parent);
            }
        }
        return undefined;
    }
    private async jumpToFirstMatch(uri: vscode.Uri, searchString: string): Promise<void> {
        let editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.uri.toString() !== uri.toString()) {
            editor = await vscode.window.showTextDocument(uri, {
                preserveFocus: false,
                preview: false,
            });
        }
        await vscode.commands.executeCommand('actions.find');
        await vscode.commands.executeCommand('editor.actions.findWithArgs', {
            searchString,
            isRegex: false,
            matchWholeWord: true,
            isCaseSensitive: true,
            preserveCase: false,
        });
        const document = editor.document;
        const escaped = searchString.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`\\b${escaped}\\b`);
        const match = regex.exec(document.getText());
        if (match) {
            const start = document.positionAt(match.index);
            const end = document.positionAt(match.index + match[0].length);
            editor.selection = new vscode.Selection(start, end);
            editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenter);
        }
    }
    private lookupEntryGroup(selectionKey: string): ShaderEntryGroup | undefined {
        const idx = selectionKey.lastIndexOf('::');
        if (idx < 0) { return undefined; }
        const filePath = selectionKey.substring(0, idx);
        const groupName = selectionKey.substring(idx + 2);
        const groups = this.groupCache.get(filePath);
        return groups?.find(g => g.name === groupName);
    }
    // Resolve a readonlyDefine node from the grouped view back to its owning entry group, container
    // (commonDefineList vs permutation.deltaDefines), file, and optionally the owning variant.
    private resolveGroupedDefine(node: ShaderReadonlyDefine): {
        file: ShaderVariantFile; group: ShaderEntryGroup;
        container: ShaderCommonDefineList | ShaderPermutation;
        variant?: ShaderVariant;
    } | null {
        for (const groups of this.groupCache.values()) {
            for (const group of groups) {
                if (node.groupName && group.name !== node.groupName) { continue; }
                // Check commonDefineList
                if (group.commonDefineList.defines.some(d => d === node)) {
                    return { file: this.files.get(group.uri.path)!, group, container: group.commonDefineList };
                }
                // Check deltaDefines in each permutation
                for (const perm of group.permutationList.permutations) {
                    if (perm.deltaDefines.some(d => d === node)) {
                        return { file: this.files.get(group.uri.path)!, group, container: perm, variant: perm.variant };
                    }
                }
            }
        }
        return null;
    }
    // Find the owning entry group + file for a grouped-view container node (commonDefineList,
    // varyingDefineList, permutationList) by identity.
    private findEntryGroupByNode(node: ShaderVariantNode): { group: ShaderEntryGroup; file: ShaderVariantFile; } | null {
        for (const [path, groups] of this.groupCache) {
            for (const group of groups) {
                if (group.commonDefineList === node || group.varyingDefineList === node || group.permutationList === node || group.includeList === node) {
                    return { group, file: this.files.get(path)! };
                }
            }
        }
        return null;
    }
    // Send the current varying-selection defines (common + selected varying) to the server so it
    // re-parses with them — even when the combination doesn't match any real permutation.
    private notifyVaryingSelection(selectionKey: string, sel: Map<string, string>): void {
        const ownerGroup = this.lookupEntryGroup(selectionKey);
        if (!ownerGroup) { return; }
        // Start with global shader-validator.defines; common + varying overlay on top (variant wins).
        const globalDefines: { [key: string]: string } =
            vscode.workspace.getConfiguration("shader-validator").get<{ [key: string]: string }>("defines") ?? {};
        const fullDefines: { [key: string]: string } = { ...globalDefines };
        for (const d of ownerGroup.commonDefineList.defines) {
            if (d.value !== '_') { fullDefines[d.label] = d.value; }
        }
        for (const [key, value] of sel) {
            if (value === '_') { delete fullDefines[key]; }
            else { fullDefines[key] = value; }
        }
        const includes = ownerGroup.includeList.includes.map(i => i.include);
        vscode.workspace.openTextDocument(ownerGroup.uri).then(doc => {
            const shadeLang = doc.languageId.charAt(0).toUpperCase() + doc.languageId.slice(1);
            this.sendShaderVariantNotification({
                    url: this.server.uriAsString(ownerGroup.uri),
                    shadingLanguage: shadeLang,
                    entryPoint: ownerGroup.name,
                    stage: ShaderStage[ownerGroup.stageNode.stage],
                    defines: fullDefines,
                    includes,
                }, ownerGroup.uri);
        });
    }
    // Clear the varying selection for this entry group and tell the server there is no active variant.
    private notifyVaryingClear(selectionKey: string): void {
        const ownerGroup = this.lookupEntryGroup(selectionKey);
        if (!ownerGroup) { return; }
        this.sendShaderVariantNotification(null, ownerGroup.uri);
    }
    // Required for TreeView.reveal (used to auto-reveal a file node when its editor becomes active).
    public getParent(element: ShaderVariantNode): ShaderVariantNode | undefined {
        if (element.kind === 'file') {
            if (this.treeMode) {
                // In tree mode, find the parent directory from dirCache.
                const relPath = vscode.workspace.asRelativePath(element.uri);
                const lastSlash = Math.max(relPath.lastIndexOf('/'), relPath.lastIndexOf('\\'));
                if (lastSlash >= 0) {
                    const dirPath = relPath.slice(0, lastSlash);
                    // Walk up to find the closest containing directory.
                    let parts = dirPath.split(/[/\\]/);
                    for (let i = parts.length; i > 0; i--) {
                        const key = parts.slice(0, i).join('/');
                        const dir = this.dirCache.get(key);
                        if (dir) { return dir; }
                    }
                }
            }
            return undefined;
        }
        if (element.kind === 'directory') {
            const dir = element as ShaderDirectoryNode;
            const lastSlash = Math.max(dir.relPath.lastIndexOf('/'), dir.relPath.lastIndexOf('\\'));
            if (lastSlash >= 0) {
                const parentKey = dir.relPath.slice(0, lastSlash);
                return this.dirCache.get(parentKey);
            }
            return undefined;
        }
        if (element.kind === 'entryGroup') {
            return this.files.get(element.uri.path);
        }
        for (let groups of this.groupCache.values()) {
            for (let group of groups) {
                if (element === group.stageNode || element === group.commonDefineList || element === group.includeList || element === group.permutationList || element === group.varyingDefineList) {
                    return group;
                }
                if (group.permutationList.permutations.some(p => p === element)) {
                    return group.permutationList;
                }
                for (let perm of group.permutationList.permutations) {
                    if (perm.deltaDefines.some(d => d === element)) {
                        return perm;
                    }
                }
                if (group.commonDefineList.defines.some(d => d === element)) {
                    return group.commonDefineList;
                }
                if (group.includeList.includes.some(i => i === element)) {
                    return group.includeList;
                }
                // varyingDefine and varyingDefineValue
                for (const vd of group.varyingDefineList.defines) {
                    if (element === vd) {
                        return group.varyingDefineList;
                    }
                    if (vd.values.some(v => v === element)) {
                        return vd;
                    }
                }
            }
        }
        return undefined;
    }
    // Reveal (and select, without stealing focus) the panel node for a file.
    private revealFile(file: ShaderVariantFile) {
        this.tree.reveal(file, { select: true, focus: false, expand: true }).then(undefined, () => {});
    }
    // If the given editor is a tracked shader file, reveal its node in the panel.
    private revealActiveEditorFile(editor: vscode.TextEditor | undefined) {
        if (!editor || editor.document.uri.scheme !== 'file') {
            return;
        }
        let file = this.files.get(editor.document.uri.path);
        if (file) {
            this.revealFile(file);
        }
    }

    public open(uri: vscode.Uri): void {
        this.openOrAddVariant(uri, null);
    }
    public openOrAddVariant(uri: vscode.Uri, variant: ShaderVariant | null): void {
        if (uri.scheme !== 'file') {
            return;
        }
        // If adding active variant, remove all currently active ones.
        if (variant) {
            if (variant.isActive) {
                for (let [url, file] of this.files) {
                    let needRefresh = false;
                    for (let otherVariant of file.variants) {
                        if (otherVariant.isActive) {
                            needRefresh = true;
                            otherVariant.isActive = false;
                        }
                    }
                    if (needRefresh) {
                        // Refresh file & all its childs
                        this.refresh(file, file);
                    }
                }
            }
        }
        let file = this.files.get(uri.path);
        if (!file) {
            let newFile : ShaderVariantFile = {
                kind: 'file',
                uri: uri,
                variants: variant ? [variant] : []
            };
            this.files.set(uri.path, newFile);
            this.invalidateGroups(uri.path);
            this.refresh(null, this.files.get(uri.path)!); // This has to be here
        } else if (variant) {
            file.variants.push(variant);
            this.invalidateGroups(uri.path);
            this.refresh(null, file);
        }
    }
    public close(uri: vscode.Uri): void {
        let file = this.files.get(uri.path);
        if (file) {
            // We keep it if some variants where defied.
            if (file.variants.length === 0) {
                this.files.delete(uri.path);
                this.invalidateGroups(uri.path);
                this.refreshAll();
            }
        }
    }
    // Recursively collect every *.json file under a folder, caching the listing per resolved root.
    // The folder is a tree of engine-dumped JSON configs (e.g. UE ShaderDebugInfo), so nested
    // directories are walked.
    private async collectJsonFiles(folderUri: vscode.Uri): Promise<vscode.Uri[]> {
        if (this.jsonFileCache && this.jsonFileCache.root === folderUri.path) {
            return this.jsonFileCache.files;
        }
        let files: vscode.Uri[] = [];
        let stack: vscode.Uri[] = [folderUri];
        const maxFiles = 200000; // safety bound against pathologically large trees
        while (stack.length > 0 && files.length < maxFiles) {
            let dir = stack.pop()!;
            let entries: [string, vscode.FileType][];
            try {
                entries = await vscode.workspace.fs.readDirectory(dir);
            } catch (e) {
                continue; // unreadable / missing dir, skip
            }
            for (let [name, type] of entries) {
                let child = vscode.Uri.joinPath(dir, name);
                if (type & vscode.FileType.Directory) {
                    stack.push(child);
                } else if ((type & vscode.FileType.File) && name.toLowerCase().endsWith('.json')) {
                    files.push(child);
                }
            }
        }
        this.jsonFileCache = { root: folderUri.path, files };
        return files;
    }
    // Scan the configured variant folder for every JSON config describing the opened shader (all
    // entry points x all permutations, across nested directories) and merge them into one
    // de-duplicated variant list attached to uri. Returns null when no folder is configured or no
    // matching config is found. Logs & skips unreadable/invalid files; never throws. `forceRescan`
    // rebuilds the cached file listing so explicit Refresh / Add File picks up freshly dumped JSONs.
    private async loadVariantsFromConfig(uri: vscode.Uri, forceRescan: boolean = false): Promise<ShaderVariant[] | null> {
        if (uri.scheme !== 'file') {
            return null;
        }
        let variantFolder = vscode.workspace.getConfiguration("shader-validator").get<string>("variantFolder");
        if (!variantFolder || variantFolder.length === 0) {
            return null;
        }
        let resolvedFolder = resolveVSCodeVariables(variantFolder);
        if (resolvedFolder.length === 0) {
            return null;
        }
        let folderUri = vscode.Uri.file(resolvedFolder);
        if (forceRescan) {
            this.jsonFileCache = null;
        }
        let jsonFiles = await this.collectJsonFiles(folderUri);

        // Pre-filter by file name so we only parse JSONs named after the opened shader (engines name
        // each dump <ShaderName>.json / <ShaderName>_DebugCompile.json), avoiding parsing the tree.
        let openedBaseName = getBaseName(uri.path);                 // e.g. FXAAShader.usf
        let dotIndex = openedBaseName.lastIndexOf('.');
        let stemLower = (dotIndex > 0 ? openedBaseName.substring(0, dotIndex) : openedBaseName).toLowerCase();
        let configs: ShaderVariantConfig[] = [];
        for (let fileUri of jsonFiles) {
            let jsonName = getBaseName(fileUri.path).toLowerCase();
            if (!jsonName.startsWith(stemLower)) {
                continue;
            }
            let rest = jsonName.slice(stemLower.length);            // "" never (ends .json); ".json", "_debugcompile.json", ".variants.json"...
            if (!(rest === '.json' || rest.startsWith('.') || rest.startsWith('_'))) {
                continue; // e.g. fxaashaderhelper.json -> reject
            }
            try {
                let bytes = await vscode.workspace.fs.readFile(fileUri);
                configs.push(parseShaderVariantConfig(new TextDecoder('utf-8').decode(bytes)));
            } catch (e) {
                let message = `Failed to import shader variants from ${fileUri.fsPath}: ${e instanceof Error ? e.message : e}`;
                console.warn(message);
                this.server.log(message);
            }
        }
        if (configs.length === 0) {
            return null; // No config for this shader.
        }
        let merged = mergeVariantConfigs(uri, configs, openedBaseName);
        return merged.length > 0 ? merged : null;
    }
    // Load the config(s) for a shader and replace its variants in the tree. Returns the imported
    // configs were found and applied. Used only by explicit user actions (Refresh / Add File).
    private async importVariantsFromConfig(uri: vscode.Uri, forceRescan: boolean = true): Promise<number> {
        const statusMessage = vscode.window.setStatusBarMessage("Collecting variant json...");
        try {
            let variants = await this.loadVariantsFromConfig(uri, forceRescan);
            if (variants && variants.length > 0) {
                this.applyImportedVariants(uri, variants);
                vscode.window.showInformationMessage(
                    `Collected ${variants.length} variant json entr${variants.length === 1 ? "y" : "ies"} for ${vscode.workspace.asRelativePath(uri)}.`,
                );
                return variants.length;
            }
            vscode.window.showWarningMessage(`No variant json found for ${vscode.workspace.asRelativePath(uri)}.`);
            return 0;
        } finally {
            statusMessage.dispose();
        }
    }
    // Replace the variants of a file with imported ones, only if they actually differ (avoids
    // churn & dirty edits when re-opening). Preserves the active selection when a matching
    // variant still exists.
    private applyImportedVariants(uri: vscode.Uri, variants: ShaderVariant[]): void {
        let file = this.files.get(uri.path);
        // Change detection by full signature, ignoring active state & order-independent of it.
        let project = (vs: ShaderVariant[]) => JSON.stringify(vs.map(variantSignature));
        if (file && project(file.variants) === project(variants)) {
            return; // Nothing changed.
        }
        // Preserve active selection if a matching variant still exists in the new set.
        let previousActive = file ? file.variants.find(v => v.isActive) : undefined;
        if (previousActive) {
            let previousSignature = variantSignature(previousActive);
            let match = variants.find(v => variantSignature(v) === previousSignature);
            if (match) {
                match.isActive = true;
            }
        }
        if (file) {
            file.variants = variants;
        } else {
            file = { kind: 'file', uri: uri, variants: variants };
            this.files.set(uri.path, file);
        }
        this.invalidateGroups(uri.path);
        this.save();
        this.onDidChangeTreeDataEmitter.fire();
        this.notifyVariantChanged();
        this.updateDecorations();
        // If the freshly-imported file is the one in the active editor, reveal it (the import is
        // async, so the open-triggered reveal may have run before the file existed in the panel).
        if (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri.path === uri.path) {
            this.revealActiveEditorFile(vscode.window.activeTextEditor);
        }
    }
    // Activate the clicked variant.  No longer re-reads JSON configs from disk on every toggle —
    // use the manual Refresh button (shader-validator.refreshVariants) to pull in config changes.
    private async activateVariantWithRefresh(clicked: ShaderVariant): Promise<void> {
        let signature = variantSignature(clicked);
        let file = this.files.get(clicked.uri.path);
        // The clicked node may have been removed by an external edit; re-find by signature.
        let toActivate = file ? file.variants.find(v => variantSignature(v) === signature) : clicked;
        if (file && !toActivate) {
            vscode.window.showWarningMessage(`The selected shader variant no longer exists for ${vscode.workspace.asRelativePath(clicked.uri)}. Use the Refresh button to re-import configs.`);
        }
        // Single-pass activation: deactivate the old variant(s) and activate the new one
        // in one sweep.  The server receives a single didChangeShaderVariant with the new
        // defines (or null if clearing); no null→wait→real workaround is needed.
        for (let [, otherFile] of this.files) {
            let needRefresh = false;
            for (let other of otherFile.variants) {
                let shouldBeActive = (toActivate !== undefined && other === toActivate);
                if (other.isActive !== shouldBeActive) {
                    other.isActive = shouldBeActive;
                    needRefresh = true;
                }
            }
            if (needRefresh) {
                this.refresh(otherFile, otherFile);
            }
        }
    }
    async promptEntryPoint() : Promise<string | undefined> {
        return await vscode.window.showInputBox({
            title: "Entry point",
            value: "main",
            prompt: "Select an entry point for your variant. Note that specifying this along the stage might improve performances.",
            placeHolder: "main"
        });
    }
    async promptShaderStage() : Promise<ShaderStage | undefined> {
        let stage = await vscode.window.showQuickPick(
            [
                ShaderStage[ShaderStage.auto],
                ShaderStage[ShaderStage.vertex],
                ShaderStage[ShaderStage.fragment],
                ShaderStage[ShaderStage.compute],
                ShaderStage[ShaderStage.tesselationControl],
                ShaderStage[ShaderStage.tesselationEvaluation],
                ShaderStage[ShaderStage.mesh],
                ShaderStage[ShaderStage.task],
                ShaderStage[ShaderStage.geometry],
                ShaderStage[ShaderStage.rayGeneration],
                ShaderStage[ShaderStage.closestHit],
                ShaderStage[ShaderStage.anyHit],
                ShaderStage[ShaderStage.callable],
                ShaderStage[ShaderStage.miss],
                ShaderStage[ShaderStage.intersect],
            ],
            {
                title: "Shader stage"
            }
        );
        if (stage) {
            return ShaderStage[stage as keyof typeof ShaderStage];
        } else {
            return undefined;
        }
    }
    public async add(node: ShaderVariantNode) {
        if (node.kind === 'file') {
            let entryPoint = await this.promptEntryPoint();
            if (entryPoint) {
                let stage = await this.promptShaderStage();
                if (stage) {
                    node.variants.push({
                        kind: 'variant',
                        uri: node.uri,
                        name: entryPoint,
                        isActive: false,
                        stage: {
                            kind: 'stage',
                            stage: stage
                        },
                        defines: {
                            kind: 'defineList',
                            defines:[]
                        },
                        includes: {
                            kind: 'includeList',
                            includes:[]
                        },
                    });
                    this.invalidateGroups(node.uri.path);
                    this.refresh(node, node);
                }
            }
        } else if (node.kind === 'defineList') {
            let label = await vscode.window.showInputBox({
                title: "Macro label",
                value: "MY_MACRO",
                prompt: "Select a label for you macro.",
                placeHolder: "MY_MACRO"
            });
            if (label) {
                let value = await vscode.window.showInputBox({
                    title: "Macro value",
                    value: "1",
                    prompt: "Select a value for you macro.",
                    placeHolder: "1"
                });
                if (value) {
                    node.defines.push({
                        kind: "define",
                        label: label,
                        value: value,
                    });
                    this.refresh(node, null);
                }
            }
        } else if (node.kind === 'includeList') {
            let include = await vscode.window.showInputBox({
                title: "Include path",
                value: "${workspaceFolder}/",
                prompt: "Select a path for your include.",
                placeHolder: "${workspaceFolder}/"
            });
            if (include) {
                node.includes.push({
                    kind: "include",
                    include: include,
                });
                this.refresh(node, null);
            }
        } else if (node.kind === 'commonDefineList') {
            // Add a define to ALL permutations in this entry group.
            const owner = this.findEntryGroupByNode(node);
            if (!owner) { return; }
            let label = await vscode.window.showInputBox({
                title: "Macro label",
                prompt: "Select a label for your macro (added to all permutations).",
                placeHolder: "MY_MACRO"
            });
            if (!label) { return; }
            let value = await vscode.window.showInputBox({
                title: "Macro value", value: "1",
                prompt: "Select a value.", placeHolder: "1"
            });
            if (!value) { return; }
            for (const perm of owner.group.permutationList.permutations) {
                let existing = perm.variant.defines.defines.find((d: { label: string }) => d.label === label);
                if (existing) { existing.value = value; }
                else { perm.variant.defines.defines.push({ kind: 'define', label, value }); }
            }
            this.invalidateGroups(owner.group.uri.path);
            this.refresh(owner.file, owner.file);
            this.notifyVariantChanged();
        } else if (node.kind === 'varyingDefineList') {
            // Add a define to the active permutation only.
            const owner = this.findEntryGroupByNode(node);
            if (!owner) { return; }
            const activePerm = owner.group.permutationList.permutations.find(p => p.variant.isActive);
            let label = await vscode.window.showInputBox({
                title: "Macro label", placeHolder: "MY_MACRO",
                prompt: `Add to ${activePerm ? 'active' : 'first'} permutation`,
            });
            if (!label) { return; }
            let value = await vscode.window.showInputBox({
                title: "Macro value", value: "1",
                prompt: "Select a value.", placeHolder: "1"
            });
            if (!value) { return; }
            const target = activePerm ?? owner.group.permutationList.permutations[0];
            if (!target) { return; }
            let existing = target.variant.defines.defines.find((d: { label: string }) => d.label === label);
            if (existing) { existing.value = value; }
            else { target.variant.defines.defines.push({ kind: 'define', label, value }); }
            this.invalidateGroups(owner.group.uri.path);
            this.refresh(owner.file, owner.file);
            this.notifyVariantChanged();
        } else if (node.kind === 'varyingDefine') {
            // Add a new value for this varying key by cloning EVERY existing permutation in the
            // entry group and setting the key to the new value in each clone — this properly
            // expands the combinatorial space (e.g. adding a 2nd value doubles the count).
            let value = await vscode.window.showInputBox({
                title: `New value for ${node.label}`,
                prompt: `Create new permutations with ${node.label}=<value>`,
                placeHolder: "2"
            });
            if (!value) { return; }
            const owner = this.lookupEntryGroup(node.selectionKey);
            if (!owner) { return; }
            const newValue = value;
            const clones: ShaderVariant[] = [];
            for (const perm of owner.permutationList.permutations) {
                const cloned: ShaderVariant = {
                    kind: 'variant',
                    uri: perm.variant.uri,
                    name: perm.variant.name,
                    isActive: false,
                    stage: { kind: 'stage', stage: perm.variant.stage.stage },
                    defines: {
                        kind: 'defineList',
                        defines: perm.variant.defines.defines.map(d => ({
                            kind: 'define' as const, label: d.label,
                            value: d.label === node.label ? newValue : d.value,
                        })),
                    },
                    includes: {
                        kind: 'includeList',
                        includes: perm.variant.includes.includes.map(i => ({ kind: 'include' as const, include: i.include })),
                    },
                };
                if (!cloned.defines.defines.some(d => d.label === node.label)) {
                    cloned.defines.defines.push({ kind: 'define', label: node.label, value: newValue });
                }
                clones.push(cloned);
            }
            let file = this.files.get(owner.uri.path);
            if (file) {
                file.variants.push(...clones);
                this.invalidateGroups(owner.uri.path);
                this.refresh(file, file);
                this.notifyVariantChanged();
            }
        }
    }
    public async edit(node: ShaderVariantNode) {
        if (node.kind === 'variant') {
            let name = await vscode.window.showInputBox({
                title: "Entry point selection",
                value: node.name,
                prompt: "Select an entry point name for your variant",
                placeHolder: "main"
            });
            if (name) {
                node.name = name;
                this.refresh(node, null);
            }
        } else if (node.kind === 'define') {
            let label = await vscode.window.showInputBox({
                title: "Macro label",
                value: node.label,
                prompt: "Select a label for you macro.",
                placeHolder: "MY_MACRO"
            });
            let value = await vscode.window.showInputBox({
                title: "Macro value",
                value: node.value,
                prompt: "Select a value for you macro.",
                placeHolder: "0"
            });
            if (label) {
                node.label = label;
            }
            if (value) {
                node.value = value;
            }
            if (value || label) {
                this.refresh(node, null);
            }
        } else if (node.kind === 'include') {
            let include = await vscode.window.showInputBox({
                title: "Include path",
                value: node.include,
                prompt: "Select a path for your include.",
                placeHolder: "${workspaceFolder}/"
            });
            if (include) {
                node.include = include;
                this.refresh(node, null);
            }
        } else if (node.kind === 'stage') {
            let stage = await this.promptShaderStage();
            if (stage) {
                node.stage = stage;
                this.refresh(node, null);
            }
        } else if (node.kind === 'readonlyDefine') {
            const resolved = this.resolveGroupedDefine(node);
            if (!resolved) { return; }
            let label = await vscode.window.showInputBox({
                title: "Macro label", value: node.label,
                prompt: "Select a label.", placeHolder: "MY_MACRO"
            });
            let value = await vscode.window.showInputBox({
                title: "Macro value", value: node.value === '_' ? '' : node.value,
                prompt: "Select a value (empty = undefined `_`).", placeHolder: "0"
            });
            const newValue = (value !== undefined && value !== '') ? value : '_';
            if (resolved.container.kind === 'commonDefineList') {
                // Update across ALL permutations.
                for (const perm of resolved.group.permutationList.permutations) {
                    let def = perm.variant.defines.defines.find(d => d.label === node.label);
                    if (def) { def.value = newValue; }
                    if (label && label !== node.label) { def!.label = label; }
                }
            } else {
                // Update only the owning permutation.
                let def = resolved.variant!.defines.defines.find(d => d.label === node.label);
                if (def) { def.value = newValue; }
                if (label && label !== node.label && def) { def.label = label; }
            }
            this.invalidateGroups(resolved.group.uri.path);
            this.refresh(resolved.file, resolved.file);
        }
    }
    public delete(node: ShaderVariantNode) {
        if (node.kind === 'file') {
            this.files.delete(node.uri.path);
            this.invalidateGroups(node.uri.path);
            this.refreshAll();
        } else if (node.kind === 'variant') {
            let cachedFile = this.files.get(node.uri.path);
            if (cachedFile) {
                let index = cachedFile.variants.indexOf(node);
                if (index > -1) {
                    cachedFile.variants.splice(index, 1);
                    this.invalidateGroups(cachedFile.uri.path);
                    this.refresh(cachedFile, cachedFile);
                }
            }
        } else if (node.kind === 'define') {
            // Dirty remove, might be costly when lot of elements...
            for (let [_, file] of this.files) {
                let found = false;
                for (let variant of file.variants) {
                    let index = variant.defines.defines.indexOf(node);
                    if (index > -1) {
                        variant.defines.defines.splice(index, 1);
                        // Refresh variant for description
                        this.invalidateGroups(file.uri.path);
                        this.refresh(variant, file);
                        found = true;
                        break;
                    }
                }
                if (found) {
                    break;
                }
            }
        } else if (node.kind === 'include') {
            // Dirty remove, might be costly when lot of elements...
            for (let [uri, file] of this.files) {
                let found = false;
                for (let variant of file.variants) {
                    let index = variant.includes.includes.indexOf(node);
                    if (index > -1) {
                        variant.includes.includes.splice(index, 1);
                        this.invalidateGroups(file.uri.path);
                        this.refresh(variant.includes, file);
                        found = true;
                        break;
                    }
                }
                if (found) {
                    break;
                }
            }
        } else if (node.kind === 'readonlyDefine') {
            const resolved = this.resolveGroupedDefine(node);
            if (!resolved) { return; }
            if (resolved.container.kind === 'commonDefineList') {
                // Remove from ALL permutations.
                for (const perm of resolved.group.permutationList.permutations) {
                    let idx = perm.variant.defines.defines.findIndex((d: { label: string }) => d.label === node.label);
                    if (idx > -1) { perm.variant.defines.defines.splice(idx, 1); }
                }
            } else {
                // Remove from the owning permutation.
                let idx = resolved.variant!.defines.defines.findIndex((d: { label: string }) => d.label === node.label);
                if (idx > -1) { resolved.variant!.defines.defines.splice(idx, 1); }
            }
            this.invalidateGroups(resolved.group.uri.path);
            this.refresh(resolved.file, resolved.file);
        } else if (node.kind === 'varyingDefineValue') {
            // Remove all permutations that have this key=value.
            const owner = this.lookupEntryGroup(node.selectionKey);
            if (!owner) { return; }
            let file = this.files.get(owner.uri.path);
            if (file) {
                file.variants = file.variants.filter(v => {
                    let def = v.defines.defines.find(d => d.label === node.defineKey);
                    return !def || def.value !== node.label;
                });
                this.invalidateGroups(owner.uri.path);
                this.refresh(file, file);
                this.notifyVariantChanged();
            }
        } else if (node.kind === 'varyingDefine') {
            // Delete this single varying key — remove it from all permutations' defines.
            const owner = this.lookupEntryGroup(node.selectionKey);
            if (!owner) { return; }
            let file = this.files.get(owner.uri.path);
            if (file) {
                for (const perm of owner.permutationList.permutations) {
                    perm.variant.defines.defines = perm.variant.defines.defines.filter(d => d.label !== node.label);
                }
                this.invalidateGroups(owner.uri.path);
                this.refresh(file, file);
                this.notifyVariantChanged();
            }
        } else if (node.kind === 'entryGroup') {
            let file = this.files.get(node.uri.path);
            if (file) {
                file.variants = file.variants.filter(v => !(v.name === node.name && v.stage.stage === node.stageNode.stage));
                this.invalidateGroups(node.uri.path);
                this.refresh(file, file);
                this.notifyVariantChanged();
            }
        }
    }
    private getDecorator(langId: string) : vscode.TextEditorDecorationType {
        // Use decorator or a default one.
        return this.decorator.get(langId) || vscode.window.createTextEditorDecorationType({
            // Minimap
            overviewRulerColor: "rgb(0, 174, 255)",
            overviewRulerLane: vscode.OverviewRulerLane.Full,
            rangeBehavior: vscode.DecorationRangeBehavior.OpenOpen,
            // Border
            borderWidth: '1px',
            borderStyle: 'solid',
        });
    }
    private updateDecoration(editor: vscode.TextEditor) {
        let file = this.files.get(editor.document.uri.path);
        let entryPoints = this.shaderEntryPointList.get(editor.document.uri.path);

        let variant = this.getActiveVariant();
        if (file && entryPoints) {
            if (variant) {
                let found = false;
                for (let entryPoint of entryPoints) {
                    if (entryPoint.entryPoint === variant.name) {
                        let decorations : vscode.DecorationOptions[]= [];
                        decorations.push({ range: entryPoint.range, hoverMessage: variant.name });
                        editor.setDecorations(this.getDecorator(editor.document.languageId), decorations);
                        found = true;
                        break;
                    }
                }
                if (!found) {
                    console.info("Entry point not found in ", entryPoints);
                    editor.setDecorations(this.getDecorator(editor.document.languageId), []);
                }
            } else {
                console.info("No active variant ", entryPoints);
                editor.setDecorations(this.getDecorator(editor.document.languageId), []);
            }
        } else {
            editor.setDecorations(this.getDecorator(editor.document.languageId), []);
        }
    }
    private updateDecorations(uri?: vscode.Uri) {
        for (let editor of vscode.window.visibleTextEditors) {
            if (editor.document.uri.scheme === 'file') {
                this.updateDecoration(editor);
            }
        }
    }
}