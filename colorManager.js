import * as THREE from 'three';

export class ColorManager {
    constructor(room, geometry, scene) {
        this.room = room;
        this.geometry = geometry;
        this.scene = scene;
        this.terrainMesh = scene.getObjectByName('terrain');
        // Tracks changes made *during* the current paint stroke
        this.currentStrokeColorChanges = {};
        // Represents the fully loaded/merged color state of the terrain
        this.terrainColors = {}; // Stores { vertexIndex: hexColorString }
        this.statusElement = document.getElementById('save-status');
        this.colorPalette = [
            { hex: '#66aa66', name: 'Grass Green' },
            { hex: '#228B22', name: 'Forest Green' },
            { hex: '#8B4513', name: 'Brown' },
            { hex: '#A0522D', name: 'Sienna' },
            { hex: '#C2B280', name: 'Sand' },
            { hex: '#F5DEB3', name: 'Wheat' },
            { hex: '#7393B3', name: 'Blue Gray' },
            { hex: '#FFFFFF', name: 'Snow' },
            { hex: '#808080', name: 'Gray' },
            { hex: '#2F4F4F', name: 'Dark Slate' },
            { hex: '#000000', name: 'Black' },
            { hex: '#8A9A5B', name: 'Moss Green' }
        ];
        this.currentColor = this.colorPalette[0].hex;
        // Track the ID of the single canonical color state record
        this.canonicalColorRecordId = null;
        // Track the timestamp of the currently applied color data to avoid loops/stale updates
        this.lastAppliedTimestamp = null;
        // Flag to prevent saving while loading initial data
        this.isLoading = true;
        // Define the specific collection name for the canonical color state
        this.collectionName = 'terrainColorState_canonical_v1'; // Changed name
    }

    initializeColorPalette() {
        const swatchesContainer = document.getElementById('colorSwatches');
        swatchesContainer.innerHTML = ''; // Clear any existing swatches

        this.colorPalette.forEach(color => {
            const swatch = document.createElement('div');
            swatch.className = 'color-swatch';
            swatch.style.backgroundColor = color.hex;
            swatch.title = color.name;
            swatch.dataset.color = color.hex;

            if (color.hex === this.currentColor) {
                swatch.classList.add('active');
            }

            swatch.addEventListener('click', (e) => {
                e.stopPropagation();
                document.querySelectorAll('.color-swatch').forEach(s => {
                    s.classList.remove('active');
                });
                swatch.classList.add('active');
                this.currentColor = color.hex;
                const event = new CustomEvent('colorChanged', {
                    detail: {
                        color: this.currentColor,
                        name: color.name
                    }
                });
                document.dispatchEvent(event);
            });

            swatchesContainer.appendChild(swatch);
        });
    }

    ensureColorAttribute() {
        if (!this.geometry.attributes.color) {
            const colors = new Float32Array(this.geometry.attributes.position.count * 3);
            // Initialize with a default base color (e.g., Grass Green)
            const defaultColor = new THREE.Color(this.colorPalette[0].hex);
            for (let i = 0; i < colors.length; i += 3) {
                colors[i] = defaultColor.r;
                colors[i + 1] = defaultColor.g;
                colors[i + 2] = defaultColor.b;
            }
            this.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
            console.log("Created initial color buffer attribute.");
        }

        if (this.terrainMesh && this.terrainMesh.material && !this.terrainMesh.material.vertexColors) {
            this.terrainMesh.material.vertexColors = true;
            this.terrainMesh.material.needsUpdate = true;
            console.log("Enabled vertex colors on material.");
        }
    }

    applyColorBrush(hitPoint, brushRadius, brushStrength) {
        this.ensureColorAttribute();

        const positions = this.geometry.attributes.position;
        const colorAttribute = this.geometry.attributes.color;
        const vertex = new THREE.Vector3();
        let colorModified = false;
        const targetColor = new THREE.Color(this.currentColor);

        for (let i = 0; i < positions.count; i++) {
            vertex.fromBufferAttribute(positions, i);
            const dx = vertex.x - hitPoint.x;
            const dz = vertex.z - hitPoint.z;
            const distance = Math.sqrt(dx * dx + dz * dz);

            if (distance < brushRadius) {
                const falloff = Math.cos((distance / brushRadius) * Math.PI / 2);
                // Adjust strength influence for color blending
                const blendFactor = Math.max(0, Math.min(1, falloff * (brushStrength / 3))); // Clamp blend factor

                const existingColor = new THREE.Color();
                existingColor.fromBufferAttribute(colorAttribute, i);
                existingColor.lerp(targetColor, blendFactor);

                colorAttribute.setXYZ(i, existingColor.r, existingColor.g, existingColor.b);

                // Store the change for this stroke, using hex string for storage
                this.currentStrokeColorChanges[i] = '#' + existingColor.getHexString();

                colorModified = true;
            }
        }

        if (colorModified) {
            colorAttribute.needsUpdate = true;
            return true; // Indicate that the geometry color was modified
        }
        return false;
    }

    async saveColorChanges() {
        // Merge changes from the current stroke into the main state representation
        if (Object.keys(this.currentStrokeColorChanges).length > 0) {
            // Update the main color data object with the changes from the stroke
            Object.assign(this.terrainColors, this.currentStrokeColorChanges);
            this.currentStrokeColorChanges = {}; // Reset stroke changes after merging
        } else {
            // console.log("No color changes in current stroke to save.");
            return; // No need to save if nothing changed
        }

        // Prevent saving if we don't have the canonical record ID
        if (!this.canonicalColorRecordId) {
            console.warn("Cannot save terrain color: Canonical record ID not yet established.");
            return;
        }

        try {
            this.showSaveStatus(true, 'Saving color...'); // Indicate color save

            const newTimestamp = new Date().toISOString();
            const saveData = {
                colorData: this.terrainColors, // Save the complete, merged state
                vertexCount: this.geometry.attributes.color.count, // Use actual attribute count
                timestamp: newTimestamp // Update timestamp
            };

            // Update the single canonical record
            await this.room.collection(this.collectionName).update(this.canonicalColorRecordId, saveData);
            // Immediately update local timestamp
            this.lastAppliedTimestamp = newTimestamp;
            console.log(`Updated canonical color state record: ${this.canonicalColorRecordId} with TS: ${newTimestamp}`);

            this.showSaveStatus(false);

        } catch (error) {
            console.error(`Error saving color state to ${this.collectionName} (ID: ${this.canonicalColorRecordId}):`, error);
            this.showSaveStatus(false, 'Error saving color!', true); // Indicate color save error
        } finally {
            this.currentStrokeColorChanges = {}; // Ensure stroke changes are cleared
        }
    }

    applyColorState(stateData) {
        if (!stateData || typeof stateData.colorData !== 'object' || !stateData.timestamp) {
            console.warn('Invalid or incomplete color state data received:', stateData);
            return false;
        }
        // Avoid re-applying the same state based on timestamp
        if (stateData.timestamp === this.lastAppliedTimestamp) {
            // console.log(`Skipping application of color state with timestamp ${stateData.timestamp} as it's already applied.`);
            return false;
        }
        // Prevent applying older states
        if (this.lastAppliedTimestamp && stateData.timestamp < this.lastAppliedTimestamp) {
            console.log(`Skipping application of older color state (received ${stateData.timestamp}, have ${this.lastAppliedTimestamp}).`);
            return false;
        }

        console.log(`Applying canonical color state (TS: ${stateData.timestamp})...`);
        this.ensureColorAttribute(); // Ensure attribute exists and material uses it
        const colorAttribute = this.geometry.attributes.color;
        let applied = false;
        // Directly replace local state with the loaded state data
        this.terrainColors = { ...stateData.colorData }; // Use spread for copy

        const defaultColor = new THREE.Color(this.colorPalette[0].hex); // Fallback color

        // Apply colors from state, defaulting if index missing or color invalid
        for (let i = 0; i < colorAttribute.count; i++) {
            const colorHex = this.terrainColors[i]; // Get hex from our copy of stateData
            let appliedColor = defaultColor; // Start with default

            if (colorHex) {
                try {
                    // Attempt to parse the color from the state
                    appliedColor = new THREE.Color(colorHex);
                } catch (e) {
                    console.warn(`Invalid color hex '${colorHex}' at index ${i}. Applying default.`);
                    // Keep appliedColor as defaultColor
                    this.terrainColors[i] = '#' + defaultColor.getHexString(); // Fix in local cache
                }
            } else {
                // Index missing in saved data, apply default
                this.terrainColors[i] = '#' + defaultColor.getHexString(); // Ensure local cache has default
            }

            colorAttribute.setXYZ(i, appliedColor.r, appliedColor.g, appliedColor.b);
            applied = true;
        }

        if (applied) {
            colorAttribute.needsUpdate = true;
            this.lastAppliedTimestamp = stateData.timestamp; // Update timestamp of applied data
            // Set ID if needed (e.g., during initial load)
            if (!this.canonicalColorRecordId && stateData.id) {
                this.canonicalColorRecordId = stateData.id;
                console.log(`Canonical color record ID set to ${this.canonicalColorRecordId} during apply.`);
            }
            console.log('Applied canonical color state to terrain geometry.');
        } else {
            console.warn('No vertices processed during color state application.');
        }
        return applied;
    }

    async loadColorData() {
        this.isLoading = true;
        this.ensureColorAttribute(); // Make sure attribute exists before loading

        try {
            console.log(`Loading canonical terrain color state from collection: ${this.collectionName}...`);

            // Fetch the list of state records. Expecting only one.
            const states = this.room.collection(this.collectionName).getList();

            if (states.length > 0) {
                // The newest (and ideally only) record is the first one
                const latestState = states[0];
                this.canonicalColorRecordId = latestState.id;
                console.log(`Found existing color state record: ${this.canonicalColorRecordId}. Applying...`);
                this.applyColorState(latestState); // Apply the found state
            } else {
                console.log(`No canonical terrain color state found in ${this.collectionName}. Creating initial default color state.`);
                // If no state exists, initialize geometry to default and create the first record
                await this.createDefaultColorStateRecord(); // Creates and saves the initial record
            }

            // Subscribe to future updates
            this.room.collection(this.collectionName).subscribe((incomingStates) => {
                if (this.isLoading) {
                    // console.log("Skipping color subscription update during initial load.");
                    return;
                }
                if (incomingStates.length > 0) {
                    const updatedState = incomingStates[0]; // Get the latest/only record

                    // Only apply if it's the record we know and timestamp is newer
                    if (updatedState.id === this.canonicalColorRecordId && updatedState.timestamp > this.lastAppliedTimestamp) {
                        console.log(`Received updated color state via subscription (ID: ${updatedState.id}, TS: ${updatedState.timestamp}). Applying...`);
                        this.applyColorState(updatedState); // Apply the full state
                    } else if (updatedState.id !== this.canonicalColorRecordId) {
                        console.warn(`Subscription received color state with unexpected ID ${updatedState.id}, expected ${this.canonicalColorRecordId}. Ignoring.`);
                    } else {
                        // Timestamp is not newer, likely our own change echoing back or already applied
                        // console.log(`Color subscription update ignored: Timestamp ${updatedState.timestamp} not newer than ${this.lastAppliedTimestamp}`);
                    }
                } else {
                    console.warn(`Canonical color state subscription returned empty list for ${this.collectionName}. State might be lost.`);
                    // Optionally recreate default state record here
                }
            });

            console.log("Color state loading process complete.");

        } catch (error) {
            console.error(`Error loading color state from ${this.collectionName}:`, error);
            // Fallback to applying default colors locally if loading fails
            this.initializeDefaultColorsLocally(); // Apply default locally but don't save yet
        } finally {
            // Ensure geometry color is updated visually after loading attempt
            if (this.geometry.attributes.color) {
                this.geometry.attributes.color.needsUpdate = true;
            }
            // Allow processing subscription updates after a delay
            setTimeout(() => { this.isLoading = false; }, 500);
        }
    }

    // Creates the initial DB record with default colors
    async createDefaultColorStateRecord() {
        try {
            console.log(`Creating initial default color state record in ${this.collectionName}...`);
            this.ensureColorAttribute();
            const colorAttribute = this.geometry.attributes.color;
            const defaultColor = new THREE.Color(this.colorPalette[0].hex);
            const defaultColorHex = '#' + defaultColor.getHexString();
            const initialColorData = {};
            this.terrainColors = {}; // Reset local cache

            for (let i = 0; i < colorAttribute.count; i++) {
                colorAttribute.setXYZ(i, defaultColor.r, defaultColor.g, defaultColor.b);
                initialColorData[i] = defaultColorHex;
                this.terrainColors[i] = defaultColorHex; // Update local cache
            }
            if (colorAttribute) colorAttribute.needsUpdate = true; // Update geometry visually

            const initialTimestamp = new Date().toISOString();
            const saveData = {
                colorData: initialColorData,
                vertexCount: colorAttribute.count,
                isInitial: true,
                timestamp: initialTimestamp
            };

            // Create the first and only record for this state type
            const stateRecord = await this.room.collection(this.collectionName).create(saveData);
            this.canonicalColorRecordId = stateRecord.id; // Store the new ID
            this.lastAppliedTimestamp = initialTimestamp; // Track its timestamp
            console.log(`Created and saved initial default color state record: ${this.canonicalColorRecordId}`);

        } catch (error) {
            console.error(`Error creating default color state record in ${this.collectionName}:`, error);
            this.canonicalColorRecordId = null; // Reset ID on failure
            this.lastAppliedTimestamp = null;
            throw error;
        }
    }

    // Only applies default colors locally without saving - used as fallback
    initializeDefaultColorsLocally() {
        console.log("Applying default colors locally as fallback...");
        this.ensureColorAttribute();
        const colorAttribute = this.geometry.attributes.color;
        const defaultColor = new THREE.Color(this.colorPalette[0].hex);
        const defaultHex = '#' + defaultColor.getHexString();
        this.terrainColors = {}; // Reset local state cache
        for (let i = 0; i < colorAttribute.count; i++) {
            colorAttribute.setXYZ(i, defaultColor.r, defaultColor.g, defaultColor.b);
            this.terrainColors[i] = defaultHex; // Update cache
        }
        if (colorAttribute) colorAttribute.needsUpdate = true;
        console.log("Applied default colors locally.");
    }

    showSaveStatus(isVisible, message = 'Saving changes...', isError = false) {
        if (!this.statusElement) return;
        // Default message handling within the function
        let statusMessage = message;
        if (message === 'Saving changes...') { // If default message is passed
            statusMessage = isError ? 'Error saving color!' : 'Saving color...';
        }

        this.statusElement.textContent = statusMessage;
        this.statusElement.style.opacity = isVisible ? '1' : '0';
        this.statusElement.style.backgroundColor = isError ? 'rgba(220,53,69,0.7)' : 'rgba(0,0,0,0.7)';
        if (isVisible && !isError) {
            // Automatically hide after a short delay
            setTimeout(() => {
                // Check if it's still the non-error saving message before hiding
                if (this.statusElement.textContent === 'Saving color...' && this.statusElement.style.opacity === '1') {
                    this.statusElement.style.opacity = '0';
                }
            }, 1500);
        }
    }
}