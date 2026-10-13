import { downloadQrPng } from "./png-export.js";
import { downloadQrSvg } from "./svg-export.js";
import {
    analyzeDamage,
    applyChanges,
    cloneMatrix,
    generateBaseline,
} from "./qr-engine.js";
import { findOptimalTextQr } from "./qart-optimizer.js";
import { CanvasGrid } from "./canvas-grid.js";
import { DEFAULT_FONT_ID, FONTS } from "./fonts.js";

const BLOCK_COLORS = [
    "#3276b1",
    "#d7698b",
    "#4f9d69",
    "#e88b36",
    "#7967ae",
    "#2f8f9d",
    "#9c6b30",
    "#667085",
];
const STATUS_RANK = { safe: 0, warning: 1, risky: 2, invalid: 3 };
const STATUS_COLOR = {
    safe: "#267244",
    warning: "#936300",
    risky: "#a14312",
    invalid: "#b42318",
};

const elements = {
    grid: document.querySelector("#qr-grid"),
    baseCanvas: document.querySelector("#qr-base-canvas"),
    analysisCanvas: document.querySelector("#qr-analysis-canvas"),
    interactionCanvas: document.querySelector("#qr-interaction-canvas"),
    animationCanvas: document.querySelector("#qr-animation-canvas"),
    legend: document.querySelector("#grid-legend"),
    devModeToggle: document.querySelector("#dev-mode-toggle"),
    textQrMessage: document.querySelector("#text-qr-message"),
    textQrFont: document.querySelector("#text-qr-font"),
    textQrBudget: document.querySelector("#text-qr-budget"),
    textQrBudgetOutput: document.querySelector("#text-qr-budget-output"),
    textQrMaxVersion: document.querySelector("#text-qr-max-version"),
    textQrMaxVersionOutput: document.querySelector(
        "#text-qr-max-version-output",
    ),
    textQrAllowSplit: document.querySelector("#text-qr-allow-split"),
    textQrAllowWrap: document.querySelector("#text-qr-allow-wrap"),
    textQrHorizontalOnly: document.querySelector("#text-qr-horizontal-only"),
    generateTextQr: document.querySelector("#generate-text-qr"),
    hqrNavigation: document.querySelector("#hqr-navigation"),
    previousHqr: document.querySelector("#previous-hqr"),
    nextHqr: document.querySelector("#next-hqr"),
    textQrStatus: document.querySelector("#text-qr-status"),
    budgetMode: document.querySelector("#budget-mode"),
    showHighlights: document.querySelector("#show-highlights"),
    highlightOptions: document.querySelector("#highlight-options"),
    showBlocks: document.querySelector("#show-blocks"),
    blockVisibility: document.querySelector("#block-visibility"),
    showKinds: document.querySelector("#show-kinds"),
    showChanges: document.querySelector("#show-changes"),
    showOriginal: document.querySelector("#show-original"),
    overallStatus: document.querySelector("#overall-status"),
    blockList: document.querySelector("#block-list"),
    remainderNote: document.querySelector("#remainder-note"),
    undo: document.querySelector("#undo"),
    redo: document.querySelector("#redo"),
    downloadSvg: document.querySelector("#download-svg"),
    download: document.querySelector("#download"),
};

for (const font of FONTS) {
    const option = document.createElement("option");
    option.value = font.id;
    option.textContent = font.label;
    elements.textQrFont.appendChild(option);
}
elements.textQrFont.value = DEFAULT_FONT_ID;

const state = {
    model: null,
    edited: [],
    damage: null,
    tool: "pencil",
    drawValue: true,
    history: [],
    future: [],
    dragging: false,
    rectangleStart: null,
    rectangleEnd: null,
    strokeBefore: null,
    strokeChanged: false,
    previewChanges: [],
    previewRejected: false,
    hiddenBlocks: new Set(),
    hoveredModule: null,
    generationController: null,
    bestGenerationCandidate: null,
    successfulSearchKey: null,
    searchContinuation: null,
    generatedResults: [],
    generatedResultIndex: -1,
    nextSearchExhausted: false,
};

const canvasGrid = new CanvasGrid(
    elements.grid,
    elements.baseCanvas,
    elements.analysisCanvas,
    elements.interactionCanvas,
    elements.animationCanvas,
);

const devModeElements = [...document.querySelectorAll(".dev-mode")];

function readUrlState() {
    const params = new URLSearchParams(window.location.search);
    return {
        content: params.has("c") ? params.get("c") : null,
        devMode: params.has("dev"),
        allowWrap: params.get("wrap") !== "0",
        fontId: FONTS.some((font) => font.id === params.get("font"))
            ? params.get("font")
            : DEFAULT_FONT_ID,
    };
}

function writeUrlState(
    content,
    fontId = elements.textQrFont.value,
    allowWrap = elements.textQrAllowWrap.checked,
) {
    const query = `?c=${encodeURIComponent(content)}${
        fontId !== DEFAULT_FONT_ID ? `&font=${encodeURIComponent(fontId)}` : ""
    }${allowWrap ? "" : "&wrap=0"}${
        elements.devModeToggle.checked ? "&dev" : ""
    }`;
    window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${query}${window.location.hash}`,
    );
}

function updateDevMode() {
    const enabled = elements.devModeToggle.checked;
    devModeElements.forEach((element) => {
        element.classList.toggle("dev-mode", !enabled);
    });
    elements.grid.setAttribute("aria-readonly", String(!enabled));
    elements.grid.style.cursor = enabled ? "crosshair" : "default";
    state.previewChanges = [];
    state.previewRejected = false;
    refreshGrid();
}

function canEditQr() {
    return elements.devModeToggle.checked && !state.generationController;
}

function getGenerationSettings() {
    return {
        message: elements.textQrMessage.value,
        fontId: elements.textQrFont.value,
        budgetRatio: Number(elements.textQrBudget.value) / 100,
        allowSplit: elements.textQrAllowSplit.checked,
        allowWrap: elements.textQrAllowWrap.checked,
        horizontalOnly: elements.textQrHorizontalOnly.checked,
        maxVersion: Number(elements.textQrMaxVersion.value),
    };
}

function generationSettingsKey(settings = getGenerationSettings()) {
    return JSON.stringify(settings);
}

function hasCurrentGenerationHistory() {
    return (
        state.successfulSearchKey === generationSettingsKey() &&
        state.generatedResultIndex >= 0
    );
}

function updateGenerationControls() {
    elements.textQrFont.disabled = Boolean(state.generationController);
    elements.textQrAllowWrap.disabled = Boolean(state.generationController);
    if (state.generationController) return;
    const hasHistory = hasCurrentGenerationHistory();
    elements.generateTextQr.hidden = hasHistory;
    elements.hqrNavigation.hidden = !hasHistory;
    elements.generateTextQr.textContent = "Generate HQR Code";
    elements.previousHqr.disabled =
        !hasHistory || state.generatedResultIndex === 0;
    elements.nextHqr.disabled =
        !hasHistory ||
        (state.generatedResultIndex === state.generatedResults.length - 1 &&
            state.nextSearchExhausted);
    elements.nextHqr.textContent = "Next HQR >";
}

function installModel(model, edited = model.matrix) {
    state.model = model;
    state.edited = cloneMatrix(edited);
    state.history = [];
    state.future = [];
    state.previewChanges = [];
    state.previewRejected = false;
    state.hoveredModule = null;
    state.hiddenBlocks = new Set(
        model.blocks.map((_, blockIndex) => blockIndex),
    );
    canvasGrid.setModel(model);
    renderBlockVisibility();
    updateAll();
}

function makeExportFilename(model, extension) {
    const value = model.message
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/^https?:\/\//, "")
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 80);
    const suffix = value || "data";
    return `hqr_v${model.version}${model.level}_${suffix}.${extension}`;
}

async function displayGeneratedResult(result, { fullAnimation = false } = {}) {
    const previousMatrix = cloneMatrix(state.edited);
    const sameSize = previousMatrix.length === result.edited.length;
    installModel(result.model, result.edited);
    elements.textQrStatus.textContent = "Drawing the finished HQR code...";
    elements.grid.classList.add("is-revealing");
    if (fullAnimation || !sameSize) {
        await canvasGrid.animateMatrix(result.edited, { duration: 1000 });
    } else {
        await canvasGrid.animateChanges(previousMatrix, result.edited, {
            duration: 1000,
        });
    }
    canvasGrid.clearAnimation();
    elements.textQrStatus.className = "generation-status is-success";
    elements.textQrStatus.textContent = `Finished: version ${result.model.version}, mask ${result.model.mask}, ${result.placement.rectangleCount} text rectangle(s), ${result.placement.lineCount} line(s)`;
    writeUrlState(
        result.model.message,
        result.fontId ?? DEFAULT_FONT_ID,
        result.allowWrap ?? true,
    );
    elements.grid.scrollIntoView({ behavior: "smooth" });
}

async function generateTextQr() {
    const settings = getGenerationSettings();
    const searchKey = generationSettingsKey(settings);
    const controller = new AbortController();
    state.generationController = controller;
    elements.textQrFont.disabled = true;
    elements.textQrAllowWrap.disabled = true;
    state.bestGenerationCandidate = null;
    elements.generateTextQr.disabled = false;
    elements.generateTextQr.textContent = "Abort computation";
    elements.textQrStatus.className = "generation-status is-working";
    elements.textQrStatus.textContent = "Preparing search...";
    let searchedSize = null;
    canvasGrid.showSearchShell(state.model);
    elements.grid.classList.add("is-busy", "is-searching");

    elements.grid.scrollIntoView({ behavior: "smooth" });

    try {
        const result = await findOptimalTextQr({
            ...settings,
            onProgress(message) {
                elements.textQrStatus.textContent = message;
            },
            onSearchModel(model) {
                if (controller.signal.aborted) return;
                const size = model.matrix.length;
                if (searchedSize === size) return;
                canvasGrid.showSearchShell(model);
                searchedSize = size;
            },
            onBestCandidate(candidate) {
                state.bestGenerationCandidate = candidate;
            },
            signal: controller.signal,
        });

        elements.generateTextQr.disabled = true;
        elements.generateTextQr.textContent = "Drawing HQR Code...";
        elements.grid.classList.remove("is-searching");
        await displayGeneratedResult(result, { fullAnimation: true });
        state.successfulSearchKey = searchKey;
        state.searchContinuation = {
            pendingResults: [],
            nextVersion: result.model.version + 1,
        };
        state.generatedResults = [result];
        state.generatedResultIndex = 0;
        state.nextSearchExhausted = result.model.version >= settings.maxVersion;
    } catch (error) {
        const wasAborted = error.name === "AbortError";
        if (wasAborted) {
            const matrix =
                state.bestGenerationCandidate?.edited ?? state.edited;
            elements.generateTextQr.disabled = true;
            elements.generateTextQr.textContent = "Aborting...";
            elements.textQrStatus.textContent =
                "Erasing the best result found...";
            elements.grid.classList.remove("is-searching");
            elements.grid.classList.add("is-erasing");
            await canvasGrid.animateMatrix(matrix, {
                erase: true,
                duration: 500,
            });
            elements.textQrStatus.className = "generation-status";
            elements.textQrStatus.textContent = "Generation aborted.";
        } else {
            elements.textQrStatus.className = "generation-status is-error";
            elements.textQrStatus.textContent = error.message;
        }
        canvasGrid.clearAnimation({ keepBlank: wasAborted });
    } finally {
        if (state.generationController === controller) {
            state.generationController = null;
        }
        state.bestGenerationCandidate = null;
        elements.generateTextQr.disabled = false;
        updateGenerationControls();
    }
}

async function showResultAt(index) {
    if (
        index < 0 ||
        index >= state.generatedResults.length ||
        state.generationController
    ) {
        return;
    }
    elements.previousHqr.disabled = true;
    elements.nextHqr.disabled = true;
    await displayGeneratedResult(state.generatedResults[index]);
    state.generatedResultIndex = index;
    updateGenerationControls();
}

async function showPreviousHqr() {
    await showResultAt(state.generatedResultIndex - 1);
}

async function showNextHqr() {
    if (state.generationController) {
        state.generationController.abort();
        elements.nextHqr.disabled = true;
        elements.nextHqr.textContent = "Aborting...";
        return;
    }
    if (state.generatedResultIndex < state.generatedResults.length - 1) {
        await showResultAt(state.generatedResultIndex + 1);
        return;
    }
    if (state.nextSearchExhausted || !hasCurrentGenerationHistory()) return;

    const settings = getGenerationSettings();
    const controller = new AbortController();
    state.generationController = controller;
    elements.textQrFont.disabled = true;
    elements.textQrAllowWrap.disabled = true;
    state.bestGenerationCandidate = null;
    elements.previousHqr.disabled = true;
    elements.nextHqr.disabled = false;
    elements.nextHqr.textContent = "Abort computation";
    elements.textQrStatus.className = "generation-status is-working";
    let searchedSize = null;
    canvasGrid.showSearchShell(state.model);
    elements.grid.classList.add("is-busy", "is-searching");

    try {
        const startVersion = state.model.version + 1;
        elements.textQrStatus.textContent = `Continuing search at Version ${startVersion}...`;
        const result = await findOptimalTextQr({
            ...settings,
            startVersion,
            onProgress(message) {
                elements.textQrStatus.textContent = message;
            },
            onSearchModel(model) {
                if (controller.signal.aborted) return;
                const size = model.matrix.length;
                if (searchedSize === size) return;
                canvasGrid.showSearchShell(model);
                searchedSize = size;
            },
            onBestCandidate(candidate) {
                state.bestGenerationCandidate = candidate;
            },
            signal: controller.signal,
        });
        state.searchContinuation = {
            pendingResults: [],
            nextVersion: result.model.version + 1,
        };

        state.generatedResults.push(result);
        elements.grid.classList.remove("is-searching");
        await displayGeneratedResult(result);
        state.generatedResultIndex = state.generatedResults.length - 1;
        state.nextSearchExhausted = result.model.version >= settings.maxVersion;
    } catch (error) {
        if (error.name === "AbortError") {
            elements.textQrStatus.className = "generation-status";
            elements.textQrStatus.textContent = "Generation aborted.";
        } else if (error.message.startsWith("No other arrangement")) {
            state.nextSearchExhausted = true;
            elements.textQrStatus.className = "generation-status";
            elements.textQrStatus.textContent = "No next HQR layout was found.";
        } else {
            elements.textQrStatus.className = "generation-status is-error";
            elements.textQrStatus.textContent = error.message;
        }
        canvasGrid.clearAnimation();
    } finally {
        if (state.generationController === controller) {
            state.generationController = null;
        }
        state.bestGenerationCandidate = null;
        updateGenerationControls();
    }
}

function handleGenerateTextQr() {
    if (state.generationController) {
        state.generationController.abort();
        elements.generateTextQr.disabled = true;
        elements.generateTextQr.textContent = "Aborting...";
        return;
    }
    generateTextQr();
}

function isEditable(row, column) {
    return canEditQr() && state.model.metadata[row][column].kind !== "function";
}

function targetValue(row, column) {
    if (state.tool === "restore") return state.model.matrix[row][column];
    return state.drawValue;
}

function makeSingleChange(row, column) {
    if (!isEditable(row, column)) return [];
    return [{ row, column, value: targetValue(row, column) }];
}

function makeRectangleChanges(start, end) {
    const changes = [];
    const top = Math.min(start.row, end.row);
    const bottom = Math.max(start.row, end.row);
    const left = Math.min(start.column, end.column);
    const right = Math.max(start.column, end.column);
    for (let row = top; row <= bottom; row += 1) {
        for (let column = left; column <= right; column += 1) {
            if (isEditable(row, column)) {
                changes.push({ row, column, value: targetValue(row, column) });
            }
        }
    }
    return changes;
}

function selectedLimit(stat) {
    if (elements.budgetMode.value === "conservative") {
        return stat.conservativeLimit;
    }
    if (elements.budgetMode.value === "theoretical") {
        return stat.theoreticalLimit;
    }
    return Infinity;
}

function assessChanges(changes) {
    const candidate = applyChanges(state.edited, changes);
    const damage = analyzeDamage(state.model, candidate);
    const exceeded = damage.blockStats.filter(
        (stat) => stat.totalDamaged > selectedLimit(stat),
    );
    const rejected =
        elements.budgetMode.value !== "warn" && exceeded.length > 0;
    return { candidate, damage, rejected };
}

function setStrokePreview(assessment, changes) {
    state.previewChanges = changes;
    state.previewRejected = assessment.rejected;
    refreshGrid();
}

function previewSingle(row, column) {
    if (state.dragging || state.tool === "rectangle") return;
    const changes = makeSingleChange(row, column).filter(
        (change) => state.edited[change.row][change.column] !== change.value,
    );
    setStrokePreview(assessChanges(changes), changes);
}

function beginStroke(row, column) {
    if (!canEditQr()) return;
    if (elements.showOriginal.checked) return;
    if (!isEditable(row, column)) {
        setStrokePreview(assessChanges([]), []);
        return;
    }
    state.dragging = true;
    state.strokeBefore = cloneMatrix(state.edited);
    state.strokeChanged = false;

    if (state.tool === "rectangle") {
        state.rectangleStart = { row, column };
        state.rectangleEnd = { row, column };
        const changes = makeRectangleChanges(
            state.rectangleStart,
            state.rectangleEnd,
        );
        setStrokePreview(assessChanges(changes), changes);
    } else {
        applyLiveChanges(makeSingleChange(row, column));
    }
}

function continueStroke(row, column) {
    if (!state.dragging) return;
    if (state.tool === "rectangle") {
        state.rectangleEnd = { row, column };
        const changes = makeRectangleChanges(
            state.rectangleStart,
            state.rectangleEnd,
        );
        setStrokePreview(assessChanges(changes), changes);
    } else {
        applyLiveChanges(makeSingleChange(row, column));
    }
}

function applyLiveChanges(changes) {
    const effective = changes.filter(
        (change) => state.edited[change.row][change.column] !== change.value,
    );
    const assessment = assessChanges(effective);
    setStrokePreview(assessment, effective);
    if (assessment.rejected || effective.length === 0) return;
    state.edited = assessment.candidate;
    state.strokeChanged = true;
    state.damage = assessment.damage;
    updateAll();
}

function finishStroke() {
    if (!state.dragging) return;
    if (state.tool === "rectangle") {
        const changes = makeRectangleChanges(
            state.rectangleStart,
            state.rectangleEnd,
        ).filter(
            (change) =>
                state.edited[change.row][change.column] !== change.value,
        );
        const assessment = assessChanges(changes);
        setStrokePreview(assessment, changes);
        if (!assessment.rejected && changes.length) {
            state.edited = assessment.candidate;
            state.damage = assessment.damage;
            state.strokeChanged = true;
        }
    }

    if (state.strokeChanged) {
        state.history.push(state.strokeBefore);
        state.future = [];
    }
    state.dragging = false;
    state.rectangleStart = null;
    state.rectangleEnd = null;
    state.previewChanges = [];
    state.previewRejected = false;
    updateAll();
}

function overallStatus(stats) {
    return stats.reduce(
        (worst, stat) =>
            STATUS_RANK[stat.status] > STATUS_RANK[worst] ? stat.status : worst,
        "safe",
    );
}

function updateAll() {
    state.damage = analyzeDamage(state.model, state.edited);
    refreshGrid();
    renderDamage();
    renderLegend();
    elements.undo.disabled = state.history.length === 0;
    elements.redo.disabled = state.future.length === 0;
}

function refreshGrid() {
    if (!state.model) return;
    canvasGrid.renderBase(state.edited, elements.showOriginal.checked);
    canvasGrid.renderOverlay({
        metadata: state.model.metadata,
        changedModules: state.damage?.changedModules ?? [],
        previewChanges: state.previewChanges,
        previewRejected: state.previewRejected,
        showHighlights: elements.showHighlights.checked,
        showBlocks: elements.showBlocks.checked,
        showKinds: elements.showKinds.checked,
        showChanges: elements.showChanges.checked,
        hiddenBlocks: state.hiddenBlocks,
        blockColors: BLOCK_COLORS,
        kindColors: { data: "#267244", ecc: "#d7698b" },
    });
}

function renderDamage() {
    const { blockStats, changedRemainderModules } = state.damage;
    const status = overallStatus(blockStats);
    elements.overallStatus.textContent = status;
    elements.overallStatus.className = status;
    elements.blockList.innerHTML = blockStats
        .map((stat) => {
            const percentage = Math.min(
                100,
                (stat.totalDamaged / Math.max(1, stat.theoreticalLimit)) * 100,
            );
            return `
        <div class="block-row" style="--block-color:${BLOCK_COLORS[stat.blockIndex % BLOCK_COLORS.length]}">
          <div class="block-row-top">
            <strong>Block ${stat.blockIndex + 1}</strong>
            <span style="color:${STATUS_COLOR[stat.status]}">${stat.status}</span>
          </div>
          <div class="block-meter">
            <span style="--meter-width:${percentage}%;--meter-color:${STATUS_COLOR[stat.status]}"></span>
          </div>
          <div class="block-counts">
            <span>${stat.totalDamaged}/${stat.theoreticalLimit} damaged</span>
            <span>${stat.damagedData} data</span>
            <span>${stat.damagedEcc} ECC</span>
            <span>${stat.dataCount} + ${stat.eccCount} bytes</span>
          </div>
        </div>
      `;
        })
        .join("");
    elements.remainderNote.textContent = state.model.remainderBitCount
        ? `${changedRemainderModules} of ${state.model.remainderBitCount} remainder modules changed. Remainder modules are not Reed–Solomon codewords and do not consume a block budget.`
        : "This version has no remainder modules.";
}

function renderLegend() {
    if (!elements.showHighlights.checked) {
        elements.legend.replaceChildren();
        return;
    }

    const items = [];
    if (elements.showBlocks.checked) {
        state.model.blocks.forEach((_, index) => {
            if (state.hiddenBlocks.has(index)) return;
            items.push({
                label: `Block ${index + 1}`,
                color: BLOCK_COLORS[index % BLOCK_COLORS.length],
            });
        });
    }
    if (elements.showKinds.checked) {
        items.push({ label: "Data", color: "#267244" });
        items.push({ label: "ECC", color: "#d7698b" });
    }
    if (elements.showChanges.checked) {
        items.push({ label: "Changed", color: "#d00000" });
    }
    items.push({ label: "Remainder", color: "#aaa" });
    elements.legend.innerHTML = items
        .map(
            ({ label, color }) =>
                `<span class="legend-item"><span class="legend-swatch" style="--swatch:${color}"></span>${label}</span>`,
        )
        .join("");
}

function updateHighlightControls() {
    const enabled = elements.showHighlights.checked;
    elements.highlightOptions.classList.toggle("is-disabled", !enabled);
    elements.showBlocks.disabled = !enabled;
    elements.showKinds.disabled = !enabled;
    elements.showChanges.disabled = !enabled;
    updateBlockVisibilityControls();
}

function updateBlockVisibilityControls() {
    const enabled =
        elements.showHighlights.checked && elements.showBlocks.checked;
    elements.blockVisibility.classList.toggle("is-disabled", !enabled);
    elements.blockVisibility.querySelectorAll("input").forEach((input) => {
        input.disabled = !enabled;
    });
}

function renderBlockVisibility() {
    elements.blockVisibility.replaceChildren();
    state.model.blocks.forEach((_, blockIndex) => {
        const label = document.createElement("label");
        label.className = "block-toggle";
        label.style.setProperty(
            "--block-color",
            BLOCK_COLORS[blockIndex % BLOCK_COLORS.length],
        );

        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = !state.hiddenBlocks.has(blockIndex);
        input.setAttribute(
            "aria-label",
            `Show highlighting for block ${blockIndex + 1}`,
        );
        input.addEventListener("change", () => {
            if (input.checked) {
                state.hiddenBlocks.delete(blockIndex);
            } else {
                state.hiddenBlocks.add(blockIndex);
            }
            refreshGrid();
            renderLegend();
        });

        const swatch = document.createElement("span");
        swatch.className = "block-toggle-swatch";
        const text = document.createElement("span");
        text.textContent = `Block ${blockIndex + 1}`;
        label.append(input, swatch, text);
        elements.blockVisibility.appendChild(label);
    });
    updateBlockVisibilityControls();
}

function handleGridPointer(event) {
    if (!canEditQr()) {
        elements.grid.style.cursor = "default";
        return;
    }
    const module = canvasGrid.moduleFromPointer(event);
    if (!module) return;
    const { row, column } = module;
    const previous = state.hoveredModule;
    if (previous && previous.row === row && previous.column === column) {
        return;
    }

    state.hoveredModule = module;
    elements.grid.style.cursor = isEditable(row, column)
        ? "crosshair"
        : "not-allowed";
    if (state.dragging) {
        continueStroke(row, column);
    } else {
        previewSingle(row, column);
    }
}

function setTool(tool) {
    state.tool = tool;
    document.querySelectorAll(".tool-button").forEach((button) => {
        button.classList.toggle("is-active", button.dataset.tool === tool);
    });
}

function undo() {
    if (!canEditQr()) return;
    if (!state.history.length) return;
    state.future.push(cloneMatrix(state.edited));
    state.edited = state.history.pop();
    state.previewChanges = [];
    updateAll();
}

function redo() {
    if (!canEditQr()) return;
    if (!state.future.length) return;
    state.history.push(cloneMatrix(state.edited));
    state.edited = state.future.pop();
    state.previewChanges = [];
    updateAll();
}

function isTextEditingTarget(target) {
    return (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target?.isContentEditable
    );
}

function makeInitialHqr() {
    const model = generateBaseline({
        version: 1,
        level: "H",
        mask: 1,
        message: "67",
        type: "byte",
        paddingBytes: [163, 60, 96, 108, 65],
    });
    const textPixels = [
        "000000000",
        "001101110",
        "010000010",
        "011100100",
        "010101000",
        "011101000",
        "000000000",
    ];
    const changes = textPixels.flatMap((line, rowOffset) =>
        [...line].map((value, columnOffset) => ({
            row: 11 + rowOffset,
            column: 11 + columnOffset,
            value: value === "1",
        })),
    );
    return { model, edited: applyChanges(model.matrix, changes) };
}

document.querySelectorAll(".tool-button").forEach((button) => {
    button.addEventListener("click", () => setTool(button.dataset.tool));
});
document.querySelectorAll(".color-button").forEach((button) => {
    button.addEventListener("click", () => {
        state.drawValue = button.dataset.value === "black";
        document.querySelectorAll(".color-button").forEach((item) => {
            item.classList.toggle("is-active", item === button);
        });
    });
});

elements.grid.addEventListener("pointerdown", (event) => {
    if (!canEditQr()) return;
    const module = canvasGrid.moduleFromPointer(event);
    if (!module) return;
    event.preventDefault();
    elements.grid.focus({ preventScroll: true });
    try {
        elements.grid.setPointerCapture(event.pointerId);
    } catch {
        // Synthetic test events do not create an active browser pointer.
    }
    state.hoveredModule = module;
    beginStroke(module.row, module.column);
});
elements.grid.addEventListener("pointermove", handleGridPointer);
elements.grid.addEventListener("pointerleave", () => {
    if (state.dragging) return;
    state.hoveredModule = null;
    elements.grid.style.cursor = canEditQr() ? "crosshair" : "default";
    state.previewChanges = [];
    state.previewRejected = false;
    refreshGrid();
});

elements.textQrBudget.addEventListener("input", () => {
    elements.textQrBudgetOutput.value = `${elements.textQrBudget.value}%`;
    updateGenerationControls();
});
elements.textQrMaxVersion.addEventListener("input", () => {
    elements.textQrMaxVersionOutput.value = elements.textQrMaxVersion.value;
    updateGenerationControls();
});
elements.textQrMessage.addEventListener("input", updateGenerationControls);
elements.textQrFont.addEventListener("change", updateGenerationControls);
elements.textQrAllowSplit.addEventListener("change", updateGenerationControls);
elements.textQrAllowWrap.addEventListener("change", updateGenerationControls);
elements.textQrHorizontalOnly.addEventListener(
    "change",
    updateGenerationControls,
);
elements.devModeToggle.addEventListener("change", () => {
    updateDevMode();
    const params = new URLSearchParams(window.location.search);
    if (params.has("c")) {
        const urlState = readUrlState();
        writeUrlState(params.get("c"), urlState.fontId, urlState.allowWrap);
    }
});
elements.generateTextQr.addEventListener("click", handleGenerateTextQr);
elements.previousHqr.addEventListener("click", showPreviousHqr);
elements.nextHqr.addEventListener("click", showNextHqr);
elements.undo.addEventListener("click", undo);
elements.redo.addEventListener("click", redo);
elements.downloadSvg.addEventListener("click", () => {
    downloadQrSvg(state.edited, makeExportFilename(state.model, "svg"));
});
elements.download.addEventListener("click", () => {
    downloadQrPng(state.edited, makeExportFilename(state.model, "png"));
});
for (const control of [
    elements.showHighlights,
    elements.showBlocks,
    elements.showKinds,
    elements.showChanges,
    elements.showOriginal,
]) {
    control.addEventListener("change", () => {
        if (control === elements.showHighlights) {
            updateHighlightControls();
        } else if (control === elements.showBlocks) {
            updateBlockVisibilityControls();
        }
        updateAll();
    });
}
elements.budgetMode.addEventListener("change", () => {
    state.previewChanges = [];
    refreshGrid();
});
window.addEventListener("pointerup", finishStroke);
window.addEventListener("pointercancel", finishStroke);
document.addEventListener("keydown", (event) => {
    if (event.altKey || isTextEditingTarget(event.target)) {
        return;
    }

    const key = event.key.toLowerCase();
    const commandKey = event.ctrlKey || event.metaKey;
    if (!canEditQr() && !(commandKey && key === "s")) return;
    if (commandKey && key === "z" && !event.shiftKey) {
        event.preventDefault();
        undo();
    } else if (commandKey && (key === "y" || (key === "z" && event.shiftKey))) {
        event.preventDefault();
        redo();
    } else if (commandKey && key === "s") {
        event.preventDefault();
        elements.download.click();
    } else if (!commandKey && !event.shiftKey) {
        const shortcutButton = {
            p: document.querySelector('[data-tool="pencil"]'),
            r: document.querySelector('[data-tool="rectangle"]'),
            u: document.querySelector('[data-tool="restore"]'),
            w: document.querySelector('[data-value="white"]'),
            b: document.querySelector('[data-value="black"]'),
        }[key];
        if (shortcutButton) {
            event.preventDefault();
            shortcutButton.click();
        }
    }
});

const urlState = readUrlState();
elements.textQrFont.value = urlState.fontId;
elements.textQrAllowWrap.checked = urlState.allowWrap;
if (urlState.content !== null) {
    elements.textQrMessage.value = urlState.content;
    elements.textQrMessage.defaultValue = urlState.content;
}
elements.devModeToggle.checked = urlState.devMode;
updateDevMode();
updateHighlightControls();
const initialHqr = makeInitialHqr();
installModel(initialHqr.model, initialHqr.edited);
updateGenerationControls();
if (urlState.content !== null) {
    void generateTextQr();
}
