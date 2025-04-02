import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TerrainDatabase } from './terraindb.js';
import { PlayerManager } from './players.js';
import { ColorManager } from './colorManager.js';

// Room setup for multiplayer
const room = new WebsimSocket();
let terrainModified = false;
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
// Configure shadow properties for better quality
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

// Initialize with flat terrain (removed random variation)
const positions = geometry.attributes.position;
geometry.computeVertexNormals(); // Compute normals after modification

let currentTool = 'raise'; // 'select', 'raise', 'lower', 'flatten', 'color'
const brushIndicator = new THREE.Mesh(
    new THREE.SphereGeometry(1, 16, 8),
    new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, opacity: 0.5, transparent: true })
);
brushIndicator.visible = false;
scene.add(brushIndicator);

const material = new THREE.MeshStandardMaterial({
    color: 0xffffff, // White base color (will be multiplied by vertex colors)
    side: THREE.DoubleSide,
    metalness: 0.0,
    roughness: 0.9,
    vertexColors: false // Will be enabled when colors are loaded
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
// Replace the previous zoom configuration with these settings
controls.zoomSpeed = 0.5;
controls.enableZoom = true;

// Custom zoom parameters for MMORPG-style zooming
let zoomState = {
    current: camera.position.distanceTo(controls.target),
    min: controls.minDistance,
    max: controls.maxDistance,
    speed: 0.08,
    smoothing: 0.1,
    target: null
};

// Override the default wheel zoom behavior
renderer.domElement.addEventListener('wheel', onMouseWheel, { passive: false });

function onMouseWheel(event) {
    event.preventDefault();
    
    // Calculate zoom direction and amount
    const zoomDirection = Math.sign(event.deltaY);
    
    // Start from current distance if no target is set
    if (zoomState.target === null) {
        zoomState.target = zoomState.current;
    }
    
    // Calculate new target zoom level with non-linear scaling for better control
    // Multiply by distance factor for more natural zooming (slower when close, faster when far)
    const distanceFactor = Math.max(0.5, Math.min(1.5, zoomState.current / 50));
    const zoomAmount = zoomDirection * zoomState.speed * distanceFactor;
    
    // Calculate zoom target with exponential adjustment for smoother steps
    zoomState.target *= Math.pow(1.1, zoomAmount);
    
    // Clamp target value to min/max constraints
    zoomState.target = THREE.MathUtils.clamp(
        zoomState.target,
        zoomState.min,
        zoomState.max
    );
}

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
const toolButtons = document.querySelectorAll('.button-group button');

// --- UI Update Functions ---
function updateSliderValue(slider, span) {
    span.textContent = parseFloat(slider.value).toFixed(1);
}

function updateActiveButton() {
    toolButtons.forEach(btn => {
        if (btn.dataset.tool === currentTool) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });
    // Show/hide flatten height slider based on the active tool
    flattenHeightControl.style.display = currentTool === 'flatten' ? 'flex' : 'none';
}

// --- Event Listeners ---
brushSizeSlider.addEventListener('input', () => updateSliderValue(brushSizeSlider, brushSizeValueSpan));
brushStrengthSlider.addEventListener('input', () => updateSliderValue(brushStrengthSlider, brushStrengthValueSpan));
flattenHeightSlider.addEventListener('input', () => updateSliderValue(flattenHeightSlider, flattenHeightValueSpan));

toolButtons.forEach(button => {
    button.addEventListener('click', (e) => {
        // Prevent triggering mousedown on canvas if clicking UI quickly
        e.stopPropagation();
        currentTool = button.dataset.tool;
        updateActiveButton();
    });
});

// Renamed from onMouseMove to avoid confusion with editing logic
renderer.domElement.addEventListener('pointermove', onPointerMoveTerrainCheck, false);
// Use pointer events for better consistency across devices
renderer.domElement.addEventListener('pointerdown', onPointerDownTerrain, false);
window.addEventListener('pointerup', onPointerUpTerrain, false); // Listen on window to catch release outside canvas
window.addEventListener('resize', onWindowResize, false);
// Prevent context menu on right-click
renderer.domElement.addEventListener('contextmenu', (event) => event.preventDefault());

// --- Event Handlers ---
// Renamed handler for clarity
function onPointerMoveTerrainCheck(event) {
    // Calculate mouse position in normalized device coordinates (-1 to +1)
    mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

    updateBrushIndicator(); // Update indicator position

    if (isMouseDown) {
        applyBrush();
    }
}

// Renamed handler for clarity
function onPointerDownTerrain(event) {
    // Ignore clicks if the mouse is over the controls panel
    const controlsPanel = document.getElementById('controls');
    if (controlsPanel && controlsPanel.contains(event.target)) return;
    // Check if the click originated on the canvas (redundant with listener on domElement, but safe)
    if (event.target !== renderer.domElement) return;
    // Ignore right clicks or middle clicks for editing
    if (event.button !== 0) return;

    isMouseDown = true;
    // Record stroke start time when brush is applied
    if (currentTool !== 'select' && terrainDB) {
        terrainDB.strokeStartTime = new Date().toISOString();
    }
    
    // Only disable camera controls when not in selection mode
    if (currentTool !== 'select') {
        controls.enabled = false; // Disable camera controls while editing
        // Ensure brush indicator updates immediately on click
        updateBrushIndicator();
        applyBrush(); // Apply brush on the first click
    }
}

// Renamed handler for clarity
function onPointerUpTerrain(event) {
    // Only act if the left mouse button was released and we were editing
    if (event.button === 0 && isMouseDown) {
        isMouseDown = false;
        controls.enabled = true; // Re-enable camera controls
        
        // Save terrain changes on end of stroke
        if (terrainModified) {
            terrainDB.saveTerrainChangesWithTimestamp(geometry);
            terrainModified = false;
        }
        
        // Save color changes if colorManager exists
        if (colorManager) {
            colorManager.saveColorChanges();
        }
    }
}

function applyBrush() {
    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObject(terrain);

    if (intersects.length > 0) {
        const intersection = intersects[0];
        const hitPoint = intersection.point;

        const brushRadius = parseFloat(brushSizeSlider.value);
        const brushStrength = parseFloat(brushStrengthSlider.value);
        const targetFlattenHeight = parseFloat(flattenHeightSlider.value);

        const positions = geometry.attributes.position;
        const vertex = new THREE.Vector3();
        let vertexModified = false;

        // Handle color tool differently - delegate to ColorManager
        if (currentTool === 'color' && colorManager) {
            return colorManager.applyColorBrush(hitPoint, brushRadius, brushStrength);
        }

        // Iterate through all vertices
        for (let i = 0; i < positions.count; i++) {
            vertex.fromBufferAttribute(positions, i);
            // Calculate distance in the XZ plane for cylindrical brush effect
            const dx = vertex.x - hitPoint.x;
            const dz = vertex.z - hitPoint.z;
            const distance = Math.sqrt(dx * dx + dz * dz);

            if (distance < brushRadius) {
                // Smoother falloff using cosine function
                const falloff = Math.cos((distance / brushRadius) * Math.PI / 2);
                const strengthFactor = brushStrength * falloff * 0.15;

                if (currentTool === 'raise') {
                    const currentHeight = positions.getY(i);
                    const newHeight = currentHeight + strengthFactor;
                    positions.setY(i, newHeight);
                    vertexModified = true;
                } else if (currentTool === 'lower') {
                    const currentHeight = positions.getY(i);
                    const newHeight = currentHeight - strengthFactor;
                    positions.setY(i, newHeight);
                    vertexModified = true;
                } else if (currentTool === 'flatten') {
                    const currentHeight = positions.getY(i);
                    const newHeight = THREE.MathUtils.lerp(currentHeight, targetFlattenHeight, strengthFactor * 0.5);
                    positions.setY(i, newHeight);
                    vertexModified = true;
                }
            }
        }

        // If vertices were modified, update the geometry
        if (vertexModified) {
            positions.needsUpdate = true;
            geometry.computeVertexNormals();
            terrainModified = true;
        }
        
        return vertexModified;
    }
    
    return false;
}

function updateBrushIndicator() {
    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObject(terrain);

    if (intersects.length > 0) {
        const intersection = intersects[0];
        brushIndicator.position.copy(intersection.point);
        const scale = parseFloat(brushSizeSlider.value) * 0.2;
        brushIndicator.scale.set(scale, scale, scale);
        
        // Only show brush indicator for brush tools
        brushIndicator.visible = (currentTool !== 'select');
        
        // Update color for paint brush
        if (currentTool === 'color' && colorManager) {
            brushIndicator.material.color.set(colorManager.currentColor);
            brushIndicator.material.wireframe = false;
            brushIndicator.material.opacity = 0.6;
        } else {
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

document.addEventListener('colorChanged', (event) => {
    const { color, name } = event.detail;
    // Switch to color tool automatically
    currentTool = 'color';
    updateActiveButton();
    
    // Update brush indicator color
    brushIndicator.material.color.set(color);
    brushIndicator.material.wireframe = false;
    brushIndicator.material.opacity = 0.6;
});

// Initialize the database connection and load terrain data
async function initializeMultiplayer() {
    try {
        await room.initialize();
        myUsername = room.peers[room.clientId].username;
        console.log(`Connected as: ${myUsername}`);
        
        // Initialize the terrain database module
        terrainDB = new TerrainDatabase(room, geometry, scene);
        await terrainDB.initialize();
        
        // Initialize color manager
        colorManager = new ColorManager(room, geometry, scene);
        colorManager.initializeColorPalette();
        await colorManager.loadColorData();
        
        // Initialize player manager
        playerManager = new PlayerManager(room, scene);
        playerManager.initialize();
        
        // Update player position in real-time
        setInterval(() => {
            playerManager.updatePlayerPosition(camera, controls);
        }, 100);
        
        console.log("Multiplayer initialization complete, terrain data loaded");
    } catch (error) {
        console.error('Error initializing multiplayer:', error);
    }
}

// --- Animation Loop ---
function animate() {
    requestAnimationFrame(animate);

    // Apply smooth MMORPG-style zooming if needed
    if (zoomState.target !== null && Math.abs(zoomState.current - zoomState.target) > 0.01) {
        // Interpolate current zoom toward target (smoothing)
        zoomState.current = THREE.MathUtils.lerp(
            zoomState.current, 
            zoomState.target, 
            zoomState.smoothing
        );
        
        // Update camera position based on new distance
        const direction = camera.position.clone().sub(controls.target).normalize();
        camera.position.copy(controls.target).add(direction.multiplyScalar(zoomState.current));
    }

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
updateActiveButton(); // Set initial active button state and flatten slider visibility

const buttonGroup = document.querySelector('.button-group');
// Check if button already exists to avoid duplicates
if (!document.getElementById('colorBtn')) {
    const colorButton = document.createElement('button');
    colorButton.id = 'colorBtn';
    colorButton.dataset.tool = 'color';
    colorButton.innerHTML = `
        <svg class="tool-icon" viewBox="0 0 24 24">
            <path d="M7,14c-1.66,0-3,1.34-3,3c0,1.31-1.16,2-2,2c0.92,1.22,2.49,2,4,2c2.21,0,4-1.79,4-4
        C10,15.34,8.66,14,7,14z M20.71,4.63l-1.34-1.34c-0.39-0.39-1.02-0.39-1.41,0L9,12.25L11.75,15l8.96-8.96
        C21.1,5.65,21.1,5.02,20.71,4.63z"/>
        </svg>
        Paint
    `;
    buttonGroup.appendChild(colorButton);
    colorButton.addEventListener('click', (e) => {
        e.stopPropagation();
        currentTool = 'color';
        updateActiveButton();
    });
}

initializeMultiplayer(); // Initialize multiplayer before starting animation
animate();