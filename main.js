import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TerrainDatabase } from './terraindb.js';
import { PlayerManager } from './players.js';
import { ColorManager } from './colorManager.js';

// Room setup for multiplayer
const room = new WebsimSocket();
let terrainHeightModifiedInStroke = false; // Tracks if height changed in current stroke
let terrainColorModifiedInStroke = false; // Tracks if color changed in this stroke
let myUsername = '';

// Will be initialized later
let terrainDB;
let playerManager;
let colorManager;

// --- Scene Setup ---
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb); // Sky blue background

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, 60, 60); // Adjusted initial camera position

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true; // Enable shadows
renderer.shadowMap.type = THREE.PCFSoftShadowMap; // Softer shadows
document.body.appendChild(renderer.domElement);

// --- Lighting ---
const ambientLight = new THREE.AmbientLight(0xffffff, 0.7); // Slightly brighter ambient
scene.add(ambientLight);

const directionalLight = new THREE.DirectionalLight(0xffffff, 1.2); // Slightly stronger directional
directionalLight.position.set(70, 120, 40); // Adjusted light position
directionalLight.castShadow = true;
directionalLight.shadow.mapSize.width = 2048;
directionalLight.shadow.mapSize.height = 2048;
directionalLight.shadow.camera.near = 1;
directionalLight.shadow.camera.far = 300; // Adjusted far plane
directionalLight.shadow.camera.left = -100;
directionalLight.shadow.camera.right = 100;
directionalLight.shadow.camera.top = 100;
directionalLight.shadow.camera.bottom = -100;
directionalLight.shadow.bias = -0.001; // Helps prevent shadow acne
scene.add(directionalLight);

// --- Terrain ---
const terrainSize = 100;
const terrainSegments = 128; // Increased detail
const geometry = new THREE.PlaneGeometry(terrainSize, terrainSize, terrainSegments, terrainSegments);
geometry.rotateX(-Math.PI / 2); // Rotate to be horizontal

// Vertices will be set during initialization by TerrainDatabase/ColorManager
let currentTool = 'raise'; // 'select', 'raise', 'lower', 'flatten', 'color'
const brushIndicator = new THREE.Mesh(
    new THREE.SphereGeometry(1, 16, 8),
    new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, opacity: 0.5, transparent: true })
);
brushIndicator.visible = false;
scene.add(brushIndicator);

// Material setup - vertexColors will be enabled by ColorManager if needed
const material = new THREE.MeshStandardMaterial({
    // color: 0xffffff, // Base color ignored when vertexColors is true
    side: THREE.DoubleSide,
    metalness: 0.0,
    roughness: 0.9,
    vertexColors: false // Initialize as false, ColorManager enables it
});

const terrain = new THREE.Mesh(geometry, material);
terrain.receiveShadow = true;
terrain.castShadow = true;
terrain.name = 'terrain'; // Name for easy reference
scene.add(terrain);

// --- Controls ---
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true; // Smooth camera movement
controls.dampingFactor = 0.05;
controls.screenSpacePanning = true;
controls.minDistance = 5;
controls.maxDistance = 150;
controls.maxPolarAngle = Math.PI / 2.1;
controls.target.set(0, 0, 0);
controls.zoomSpeed = 0.5;
controls.enableZoom = true;

// --- Terrain Editing ---
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let isMouseDown = false;
const brushSizeSlider = document.getElementById('brushSize');
const brushStrengthSlider = document.getElementById('brushStrength');
const flattenHeightSlider = document.getElementById('flattenHeight');
const brushSizeValueSpan = document.getElementById('brushSizeValue');
const brushStrengthValueSpan = document.getElementById('brushStrengthValue');
const flattenHeightValueSpan = document.getElementById('flattenHeightValue');
const flattenHeightControl = document.getElementById('flattenHeightControl');
const toolButtons = document.querySelectorAll('.button-group button'); // Selects all buttons in the group, including Paint

// --- UI Update Functions ---
function updateSliderValue(slider, span) {
    span.textContent = parseFloat(slider.value).toFixed(1);
}

function updateActiveButton() {
    const allToolButtons = document.querySelectorAll('#controls .button-group button'); // Ensure selection includes dynamic buttons if any pattern changes
    allToolButtons.forEach(btn => {
        if (btn.dataset.tool === currentTool) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });
    flattenHeightControl.style.display = currentTool === 'flatten' ? 'flex' : 'none';
    // Update brush indicator immediately when tool changes
    updateBrushIndicator();
}

// --- Event Listeners ---
brushSizeSlider.addEventListener('input', () => updateSliderValue(brushSizeSlider, brushSizeValueSpan));
brushStrengthSlider.addEventListener('input', () => updateSliderValue(brushStrengthSlider, brushStrengthValueSpan));
flattenHeightSlider.addEventListener('input', () => updateSliderValue(flattenHeightSlider, flattenHeightValueSpan));

// Add listener for all tool buttons
toolButtons.forEach(button => {
    button.addEventListener('click', (e) => {
        e.stopPropagation(); // Prevent event bubbling
        currentTool = button.dataset.tool;
        updateActiveButton();
    });
});

renderer.domElement.addEventListener('pointermove', onPointerMoveTerrainCheck, false);
renderer.domElement.addEventListener('pointerdown', onPointerDownTerrain, false);
window.addEventListener('pointerup', onPointerUpTerrain, false); // Catch release outside canvas
window.addEventListener('resize', onWindowResize, false);
renderer.domElement.addEventListener('contextmenu', (event) => event.preventDefault());

// --- Event Handlers ---
function onPointerMoveTerrainCheck(event) {
    // Prevent interaction if clicking on UI elements overlaying the canvas
    const controlsPanel = document.getElementById('controls');
    const playersPanel = document.getElementById('players-list');
    if ( (controlsPanel && controlsPanel.contains(event.target)) ||
         (playersPanel && playersPanel.contains(event.target)) ) {
        brushIndicator.visible = false; // Hide brush if pointer is over UI
        return;
    }

    mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

    updateBrushIndicator(); // Update indicator position/visibility

    if (isMouseDown && currentTool !== 'select') {
        applyBrush();
    }
}

function onPointerDownTerrain(event) {
    const controlsPanel = document.getElementById('controls');
    const playersPanel = document.getElementById('players-list');
    if ( (controlsPanel && controlsPanel.contains(event.target)) ||
         (playersPanel && playersPanel.contains(event.target)) ||
         event.target !== renderer.domElement ) {
        return; // Ignore clicks on UI or outside canvas
    }
    if (event.button !== 0) return; // Ignore non-left clicks

    isMouseDown = true;

    // Reset modification flags for the new stroke
    terrainHeightModifiedInStroke = false;
    terrainColorModifiedInStroke = false;

    if (currentTool !== 'select') {
        controls.enabled = false; // Disable camera pan/rotate while editing
        updateBrushIndicator(); // Ensure indicator is visible
        applyBrush(); // Apply brush on the first click immediately
    } else {
         controls.enabled = true; // Ensure camera is enabled in select mode
    }
}

async function onPointerUpTerrain(event) { // Make async to await saves
    if (event.button === 0 && isMouseDown) {
        isMouseDown = false;
        controls.enabled = true; // Re-enable camera controls

        // Use Promise.all to wait for both potential saves concurrently
        const savePromises = [];

        // Save terrain height changes if any occurred during the stroke
        if (terrainHeightModifiedInStroke && terrainDB) {
            console.log("Stroke ended, queueing height state save...");
            // Don't await here, add the promise to the array
            savePromises.push(terrainDB.saveTerrainChanges().then(() => {
                 terrainHeightModifiedInStroke = false; // Reset flag on successful save
                 console.log("Height state saved successfully.");
            }).catch(error => {
                console.error("Failed to save height state:", error);
                // Keep flag true? Or reset anyway? Resetting prevents continuous errors on failure.
                 terrainHeightModifiedInStroke = false;
            }));
        }

        // Save terrain color changes if any occurred during the stroke
        if (terrainColorModifiedInStroke && colorManager) {
            console.log("Stroke ended, queueing color state save...");
             // Don't await here, add the promise to the array
             savePromises.push(colorManager.saveColorChanges().then(() => {
                terrainColorModifiedInStroke = false; // Reset flag on successful save
                console.log("Color state saved successfully.");
             }).catch(error => {
                 console.error("Failed to save color state:", error);
                 terrainColorModifiedInStroke = false; // Reset to prevent continuous errors
             }));
        }

        // Wait for all pending saves to complete
        if (savePromises.length > 0) {
             console.log(`Waiting for ${savePromises.length} save operations...`);
             await Promise.all(savePromises);
             console.log("All save operations completed.");
        }
    }
}

function applyBrush() {
    if (currentTool === 'select') return; // Don't apply brush if selecting

    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObject(terrain);

    if (intersects.length > 0) {
        const intersection = intersects[0];
        const hitPoint = intersection.point;

        const brushRadius = parseFloat(brushSizeSlider.value);
        const brushStrength = parseFloat(brushStrengthSlider.value);
        const targetFlattenHeight = parseFloat(flattenHeightSlider.value);

        const positions = geometry.attributes.position;
        let vertexModified = false; // Tracks if any vertex was changed in *this specific call*

        // --- Color Application ---
        if (currentTool === 'color' && colorManager) {
            const appliedColor = colorManager.applyColorBrush(hitPoint, brushRadius, brushStrength);
            if (appliedColor) {
                terrainColorModifiedInStroke = true; // Mark that color was changed in this stroke
                vertexModified = true; // Indicate geometry update needed
                // ColorManager handles its own geometry.attributes.color.needsUpdate = true;
            }
             // Prevent height changes when painting
            return;
        }

        // --- Height Application ---
        let heightChanged = false;
        for (let i = 0; i < positions.count; i++) {
            // ... (existing logic for calculating distance, falloff, newHeight) ...

            // Only update if the height actually changed significantly
             const currentHeight = positions.getY(i); // Get current height before potential change
             let newHeight = currentHeight;

            if (currentTool === 'raise') {
                 newHeight = currentHeight + brushStrength * 0.15;
            } else if (currentTool === 'lower') {
                 newHeight = currentHeight - brushStrength * 0.15;
            } else if (currentTool === 'flatten') {
                // Lerp towards target height based on strength/falloff
                 newHeight = THREE.MathUtils.lerp(currentHeight, targetFlattenHeight, brushStrength * 0.15);
            }

            if (Math.abs(newHeight - currentHeight) > 0.001) {
                 positions.setY(i, newHeight);
                 // Accumulate change in TerrainDatabase for saving later
                 if (terrainDB) {
                     terrainDB.accumulateHeightChange(i, newHeight); // Track for saving entire state later
                 }
                 heightChanged = true; // Mark that height was modified in this applyBrush call
                 vertexModified = true;
            }
        }

        // If height vertices were modified in this call, update geometry and set stroke flag
        if (heightChanged) {
            positions.needsUpdate = true;
            geometry.computeVertexNormals(); // Normals need update when height changes
            terrainHeightModifiedInStroke = true; // Mark that height was changed in this stroke
        }
    }
}

function updateBrushIndicator() {
    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObject(terrain);

    // Hide brush if pointer is over UI (checked in pointermove) or if select tool active
     if (intersects.length > 0 && currentTool !== 'select' && brushIndicator.visible) {
        const intersection = intersects[0];
        brushIndicator.position.copy(intersection.point);
        // Make indicator size relative to brush setting
        const scale = parseFloat(brushSizeSlider.value) * 0.25; // Adjust scaling factor as needed
        brushIndicator.scale.set(scale, scale, scale);
        // brushIndicator.visible = true; // Visibility handled in pointermove and here

        // Update color/style based on tool
        if (currentTool === 'color' && colorManager) {
            brushIndicator.material.color.set(colorManager.currentColor);
            brushIndicator.material.wireframe = false;
            brushIndicator.material.opacity = 0.6;
        } else {
            // Default indicator for height tools
            brushIndicator.material.color.set(0xffffff);
            brushIndicator.material.wireframe = true;
            brushIndicator.material.opacity = 0.5;
        }
    } else {
        brushIndicator.visible = false;
    }
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

// Listen for color changes from ColorManager UI
document.addEventListener('colorChanged', (event) => {
    // const { color, name } = event.detail; // Data available if needed
    // Switch to color tool automatically when a color is picked
    currentTool = 'color';
    updateActiveButton(); // Update UI to show color tool active
    // Brush indicator color is updated in updateBrushIndicator based on currentTool
});

// Initialize Database, Color, Players
async function initializeMultiplayer() {
    try {
        console.log("Initializing multiplayer connection...");
        await room.initialize();
        myUsername = room.peers[room.clientId].username;
        console.log(`Connected as: ${myUsername}`);

        // Create managers
        colorManager = new ColorManager(room, geometry, scene);
        terrainDB = new TerrainDatabase(room, geometry, scene); // Pass geometry here

        // Initialize UI elements managed by ColorManager
        colorManager.initializeColorPalette();

        // Ensure the geometry has the color attribute BEFORE loading data
        // This prepares the buffer if it doesn't exist.
        console.log("Ensuring color attribute exists...");
        colorManager.ensureColorAttribute();

        console.log("Starting to load terrain height and color data concurrently...");
        // Load terrain and color data concurrently
        await Promise.all([
            terrainDB.loadTerrainData(),
            colorManager.loadColorData()
        ]);
        console.log("Terrain height and color data loading process finished.");

        // ---- Crucial Final Geometry Update ----
        // After both load functions have completed (which internally call applyState),
        // mark the buffers as needing update and compute normals once.
        console.log("Applying final geometry updates after loading...");
        geometry.attributes.position.needsUpdate = true;
        if (geometry.attributes.color) {
            geometry.attributes.color.needsUpdate = true;
        } else {
            console.warn("Color attribute not found on geometry after loading color data.");
        }
        // Compute normals AFTER heights (and potentially colors) are set.
        geometry.computeVertexNormals();
        console.log("Geometry updates applied and normals computed.");


        // Initialize Player Manager *after* terrain is loaded and geometry updated
        console.log("Initializing Player Manager...");
        playerManager = new PlayerManager(room, scene);
        playerManager.initialize(); // Sets up presence subscription

        // Start periodic player position updates
        setInterval(() => {
            if (playerManager) {
                playerManager.updatePlayerPosition(camera, controls);
            }
        }, 200); // Send updates 5 times/sec

        console.log("Multiplayer initialization complete.");

    } catch (error) {
        console.error('Error initializing multiplayer:', error);
        // Display an error message to the user?
        const statusElement = document.getElementById('save-status');
        if(statusElement) {
             statusElement.textContent = "Initialization Error! Refresh may be needed.";
             statusElement.style.opacity = '1';
             statusElement.style.backgroundColor = 'rgba(220,53,69,0.7)';
        }
    }
}

// --- Animation Loop ---
function animate() {
    requestAnimationFrame(animate);

    controls.update(); // Required for damping

    // Render player markers if player manager is initialized
    if (playerManager) {
        playerManager.renderPlayerPositions();
    }

    renderer.render(scene, camera);
}

// --- Initial Setup Calls ---
updateSliderValue(brushSizeSlider, brushSizeValueSpan);
updateSliderValue(brushStrengthSlider, brushStrengthValueSpan);
updateSliderValue(flattenHeightSlider, flattenHeightValueSpan);

// Paint button is now static HTML, ensure listener is attached correctly above.
updateActiveButton(); // Set initial active button state and UI visibility

initializeMultiplayer(); // Initialize multiplayer and load data
animate(); // Start the animation loop