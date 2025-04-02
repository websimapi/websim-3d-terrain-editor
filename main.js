import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

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

const material = new THREE.MeshStandardMaterial({
    color: 0x66aa66, // Slightly different green
    side: THREE.DoubleSide,
    metalness: 0.0, // Less metallic
    roughness: 0.9 // More rough
});

const terrain = new THREE.Mesh(geometry, material);
terrain.receiveShadow = true;
terrain.castShadow = true;
scene.add(terrain);

// --- Controls ---
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true; // Smooth camera movement
controls.dampingFactor = 0.1; // Increased for more responsive damping
controls.screenSpacePanning = true; // Better panning behavior
controls.minDistance = 10;
controls.maxDistance = 150; // Reduced max distance for better control
controls.maxPolarAngle = Math.PI / 2.1; // Prevent camera going below horizon
controls.target.set(0, 0, 0);
controls.zoomSpeed = 0.3; // Reduced from 0.5 for less sensitive zooming
controls.rotateSpeed = 0.7; // More controlled rotation speed
controls.panSpeed = 0.8; // Adjusted pan speed

// Add mousewheel event listener for better zoom control
renderer.domElement.addEventListener('wheel', (event) => {
    // Prevent default scrolling behavior
    event.preventDefault();
    
    // Calculate zoom direction and apply smoother zoom factor
    const zoomDirection = event.deltaY > 0 ? 1 : -1;
    const zoomFactor = 0.05; // Small value for smoother zoom
    
    // Apply zoom by moving camera closer or further from target
    const cameraDirection = new THREE.Vector3().subVectors(camera.position, controls.target).normalize();
    const distance = camera.position.distanceTo(controls.target);
    
    // Calculate new distance with easing for smoother feel
    let newDistance = distance * (1 + zoomDirection * zoomFactor);
    
    // Respect min/max distance constraints
    newDistance = THREE.MathUtils.clamp(newDistance, controls.minDistance, controls.maxDistance);
    
    // Update camera position
    camera.position.copy(controls.target).addScaledVector(cameraDirection, newDistance);
}, { passive: false });

// --- Terrain Editing ---
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let isMouseDown = false;
let currentTool = 'raise'; // 'raise', 'lower', 'flatten'
const brushIndicator = new THREE.Mesh(
    new THREE.SphereGeometry(1, 16, 8),
    new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, opacity: 0.5, transparent: true })
);
brushIndicator.visible = false;
scene.add(brushIndicator);

// --- Control Panel Elements ---
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

window.addEventListener('mousemove', onMouseMove, false);
window.addEventListener('mousedown', onMouseDown, false);
window.addEventListener('mouseup', onMouseUp, false);
window.addEventListener('resize', onWindowResize, false);
// Prevent context menu on right-click (useful if adding more mouse interactions later)
renderer.domElement.addEventListener('contextmenu', (event) => event.preventDefault());

// --- Event Handlers ---
function onMouseMove(event) {
    // Calculate mouse position in normalized device coordinates (-1 to +1)
    mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

    updateBrushIndicator(); // Update indicator position even if not editing

    if (isMouseDown) {
        applyBrush();
    }
}

function onMouseDown(event) {
    // Ignore clicks if the mouse is over the controls panel
    if (event.target.closest('#controls')) return;
    // Check if the click originated on the canvas
    if (event.target !== renderer.domElement) return;

    isMouseDown = true;
    controls.enabled = false; // Disable camera controls while editing
    applyBrush(); // Apply brush on the first click
}

function onMouseUp() {
    if (isMouseDown) {
        isMouseDown = false;
        controls.enabled = true; // Re-enable camera controls only if editing was active
        // Optional: Recompute normals once after finishing a drag for potentially better performance
        // geometry.computeVertexNormals();
    }
}

function updateBrushIndicator() {
    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObject(terrain);

    if (intersects.length > 0) {
        const intersection = intersects[0];
        brushIndicator.position.copy(intersection.point);
        const scale = parseFloat(brushSizeSlider.value) * 0.2; // Adjust scaling factor as needed
        brushIndicator.scale.set(scale, scale, scale);
        brushIndicator.visible = true;
    } else {
        brushIndicator.visible = false;
    }
}

function applyBrush() {
    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObject(terrain);

    if (intersects.length > 0) {
        const intersection = intersects[0];
        const hitPoint = intersection.point;
        // No need for faceIndex directly here, we use vertex proximity

        const brushRadius = parseFloat(brushSizeSlider.value);
        const brushStrength = parseFloat(brushStrengthSlider.value);
        const targetFlattenHeight = parseFloat(flattenHeightSlider.value);

        const positions = geometry.attributes.position;
        const vertex = new THREE.Vector3();
        let vertexModified = false;

        // Convert hitPoint to the terrain's local space if terrain has transformations
        // In this simple case, terrain is at origin with no rotation, so world space = local space.
        // If terrain was moved/rotated: hitPoint.applyMatrix4(terrain.matrixWorldInverse);

        // Iterate through all vertices
        for (let i = 0; i < positions.count; i++) {
            vertex.fromBufferAttribute(positions, i);
            // Calculate distance in the XZ plane for cylindrical brush effect
            const dx = vertex.x - hitPoint.x;
            const dz = vertex.z - hitPoint.z;
            const distance = Math.sqrt(dx * dx + dz * dz);
            // Or use 3D distance: const distance = vertex.distanceTo(hitPoint);

            if (distance < brushRadius) {
                // Smoother falloff using cosine function
                const falloff = Math.cos((distance / brushRadius) * Math.PI / 2); // Cosine falloff (0 at edge, 1 at center)
                // Or simpler linear falloff: const falloff = Math.max(0, 1 - distance / brushRadius);

                let currentHeight = positions.getY(i);
                let newHeight = currentHeight;

                // Apply tool effect based on strength and falloff
                // Delta time could be incorporated for frame-rate independent modification,
                // but for mouse drag it's often okay without it.
                const strengthFactor = brushStrength * falloff * 0.15; // Adjustment factor for sensitivity

                if (currentTool === 'raise') {
                    newHeight += strengthFactor;
                } else if (currentTool === 'lower') {
                    newHeight -= strengthFactor;
                } else if (currentTool === 'flatten') {
                    // Interpolate towards the target flatten height
                    // Using lerp for smooth flattening effect
                    newHeight = THREE.MathUtils.lerp(currentHeight, targetFlattenHeight, strengthFactor * 0.5); // Flattening can be slower
                }

                // Clamp height to prevent extreme values (optional)
                // newHeight = THREE.MathUtils.clamp(newHeight, -20, 50);

                positions.setY(i, newHeight);
                vertexModified = true; // Mark that at least one vertex was changed
            }
        }

        // If vertices were modified, update the geometry
        if (vertexModified) {
            positions.needsUpdate = true;
            geometry.computeVertexNormals(); // Recompute normals for correct lighting
        }
    }
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

// --- Animation Loop ---
function animate() {
    requestAnimationFrame(animate);

    controls.update(); // Required for damping

    // Update brush indicator visibility based on mouse interaction state potentially
    // (e.g., hide when mouse is up and not over canvas) - current logic keeps it based on raycast hit

    renderer.render(scene, camera);
}

// --- Initial Setup Calls ---
updateSliderValue(brushSizeSlider, brushSizeValueSpan);
updateSliderValue(brushStrengthSlider, brushStrengthValueSpan);
updateSliderValue(flattenHeightSlider, flattenHeightValueSpan);
updateActiveButton(); // Set initial active button state and flatten slider visibility
animate();