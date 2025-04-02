import { ColorManager } from './colorManager.js'; // May need this if color button logic depends on it

// --- State ---
export let currentTool = 'raise'; // 'select', 'raise', 'lower', 'flatten', 'color'
let colorManagerInstance = null; // To access ColorManager methods/properties if needed

// --- UI Elements ---
const brushSizeSlider = document.getElementById('brushSize');
const brushStrengthSlider = document.getElementById('brushStrength');
const flattenHeightSlider = document.getElementById('flattenHeight');
const brushSizeValueSpan = document.getElementById('brushSizeValue');
const brushStrengthValueSpan = document.getElementById('brushStrengthValue');
const flattenHeightValueSpan = document.getElementById('flattenHeightValue');
const flattenHeightControl = document.getElementById('flattenHeightControl');
const controlsPanel = document.getElementById('controls');
const colorButton = document.getElementById('colorBtn'); // Assuming it exists or is added

// --- Initialization ---
export function initializeUI(colorManager) {
    colorManagerInstance = colorManager;

    // Initialize Slider Values
    updateSliderValue(brushSizeSlider, brushSizeValueSpan);
    updateSliderValue(brushStrengthSlider, brushStrengthValueSpan);
    updateSliderValue(flattenHeightSlider, flattenHeightValueSpan);

    // Add Listeners
    brushSizeSlider.addEventListener('input', () => updateSliderValue(brushSizeSlider, brushSizeValueSpan));
    brushStrengthSlider.addEventListener('input', () => updateSliderValue(brushStrengthSlider, brushStrengthValueSpan));
    flattenHeightSlider.addEventListener('input', () => updateSliderValue(flattenHeightSlider, flattenHeightValueSpan));

    // Tool Button Listeners
    const toolButtons = document.querySelectorAll('#controls .button-group button');
    toolButtons.forEach(button => {
        button.addEventListener('click', (e) => {
            e.stopPropagation();
            if (button.dataset.tool) {
                setCurrentTool(button.dataset.tool);
            }
        });
    });

    // Initial UI state based on default tool
    updateActiveButton();

    // Listen for color changes from ColorManager UI to potentially switch tool
    document.addEventListener('colorChanged', (event) => {
        // Switch to color tool automatically when a color is picked
        setCurrentTool('color');
    });
}


// --- UI Update Functions ---
function updateSliderValue(slider, span) {
    span.textContent = parseFloat(slider.value).toFixed(1);
}

function updateActiveButton() {
    const allToolButtons = document.querySelectorAll('#controls .button-group button');
    allToolButtons.forEach(btn => {
        if (btn.dataset.tool === currentTool) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });
    flattenHeightControl.style.display = currentTool === 'flatten' ? 'flex' : 'none';
    document.dispatchEvent(new CustomEvent('toolChanged', { detail: { tool: currentTool } }));
}

// --- Setters / Getters ---
export function setCurrentTool(toolName) {
    if (currentTool !== toolName) {
        currentTool = toolName;
        console.log("Tool changed to:", currentTool);
        updateActiveButton();
    }
}

export function getCurrentTool() {
    return currentTool;
}

export function getBrushSettings() {
    return {
        size: parseFloat(brushSizeSlider.value),
        strength: parseFloat(brushStrengthSlider.value),
        flattenHeight: parseFloat(flattenHeightSlider.value)
    };
}

export function isUIInteraction(eventTarget) {
    return controlsPanel && controlsPanel.contains(eventTarget);
}

// Optional: Add color button dynamically if needed (might be better in main.js or index.html)
export function ensureColorButton() {
    const buttonGroup = document.querySelector('#controls .button-group');
    if (buttonGroup && !document.getElementById('colorBtn')) {
        const newColorButton = document.createElement('button');
        newColorButton.id = 'colorBtn';
        newColorButton.dataset.tool = 'color';
        newColorButton.innerHTML = `
            <svg class="tool-icon" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-.99 0-.83.67-1.5 1.5-1.5H16c2.76 0 5-2.24 5-5 0-4.42-4.03-8-9-8zm-5.5 9c-.83 0-1.5.67-1.5 1.5S5.67 15 6.5 15 8 14.33 8 13.5 7.33 12 6.5 12zm3-4c-.83 0-1.5.67-1.5 1.5S8.67 11 9.5 11s1.5-.67 1.5-1.5S10.33 8 9.5 8zm5 0c-.83 0-1.5.67-1.5 1.5S13.67 11 14.5 11s1.5-.67 1.5-1.5S15.33 8 14.5 8zm3 4c-.83 0-1.5.67-1.5 1.5S16.67 15 17.5 15s1.5-.67 1.5-1.5S18.33 12 17.5 12z"/>
            </svg>
            Paint
        `;
        buttonGroup.appendChild(newColorButton);
        // Add listener specifically for the new button
        newColorButton.addEventListener('click', (e) => {
            e.stopPropagation();
            setCurrentTool('color');
        });
    }
}