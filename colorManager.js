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
            // { hex: '#000000', name: 'Black' }, // Removing black as it might obscure lighting too much
            { hex: '#8A9A5B', name: 'Moss Green' }
        ];
        this.currentColor = this.colorPalette[0].hex;
        // Track the ID of the single canonical color state record
        this.canonicalColorRecordId = null;
        // Track the timestamp of the currently applied color data to avoid loops/redundancy
        this.lastAppliedTimestamp = null;
        // Flag to prevent saving while loading initial data or during application
        this.isProcessing = false;
        this.unsubscribe = null; // To store the unsubscribe function
        this.statusTimeout = null; // For hiding save status
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
        let attributeExisted = true;
        if (!this.geometry.attributes.color) {
            attributeExisted = false;
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
        return attributeExisted; // Return if it existed before this call
    }

    applyColorBrush(hitPoint, brushRadius, brushStrength) {
        this.ensureColorAttribute();

        const positions = this.geometry.attributes.position;
        const colorAttribute = this.geometry.attributes.color;
        const vertex = new THREE.Vector3();
        let colorModified = false;
        const targetColor = new THREE.Color(this.currentColor);
        const tempColor = new THREE.Color(); // Reuse color object for performance

        for (let i = 0; i < positions.count; i++) {
            vertex.fromBufferAttribute(positions, i);
            const dx = vertex.x - hitPoint.x;
            const dz = vertex.z - hitPoint.z;
            const distanceSq = dx * dx + dz * dz; // Use squared distance for comparison
            const brushRadiusSq = brushRadius * brushRadius;

            if (distanceSq < brushRadiusSq) {
                const distance = Math.sqrt(distanceSq);
                const falloff = Math.cos((distance / brushRadius) * Math.PI / 2);
                const blendFactor = Math.max(0, Math.min(1, falloff * (brushStrength / 5))); // Clamp blend factor

                const existingColor = tempColor.fromBufferAttribute(colorAttribute, i);
                const originalHex = '#' + existingColor.getHexString(); // Get hex before lerping

                existingColor.lerp(targetColor, blendFactor);

                // Only update if the color actually changed significantly
                if ('#' + existingColor.getHexString() !== originalHex) {
                    colorAttribute.setXYZ(i, existingColor.r, existingColor.g, existingColor.b);
                    // Store the change for this stroke, using the final blended hex color
                    this.currentStrokeColorChanges[i] = '#' + existingColor.getHexString();
                    colorModified = true;
                }
            }
        }

        if (colorModified) {
            colorAttribute.needsUpdate = true;
            return true; // Indicate that the geometry was modified
        }
        return false;
    }

    async saveColorChanges() {
        // Prevent saving during initial load or if already saving/applying state
        if (this.isProcessing) {
            console.log("Skipping color save: Still processing initial load or another operation.");
            return;
        }

        // Merge changes from the current stroke into the main state
        let changesToSave = false;
        if (Object.keys(this.currentStrokeColorChanges).length > 0) {
            // Check if any accumulated changes are different from the current state
            for (const index in this.currentStrokeColorChanges) {
                // Use lowercase comparison for hex strings
                if (!this.terrainColors[index] || this.terrainColors[index].toLowerCase() !== this.currentStrokeColorChanges[index].toLowerCase()) {
                    changesToSave = true;
                    break;
                }
            }
            if (changesToSave) {
                // Merge only the changed values
                this.terrainColors = { ...this.terrainColors, ...this.currentStrokeColorChanges };
            }
            this.currentStrokeColorChanges = {}; // Reset stroke changes regardless
        }

        if (!changesToSave) {
            console.log("No effective color changes in current stroke to save.");
            return; // No need to save if nothing actually changed
        }

        // Ensure color attribute exists before saving
        if (!this.geometry.attributes.color) {
            console.error("Cannot save color changes: Color attribute missing.");
            return;
        }
        // Prevent saving if no data exists (shouldn't happen after initialization)
        if (Object.keys(this.terrainColors).length === 0) {
            console.log("Skipping color save: No color data available.");
            return;
        }

        this.isProcessing = true; // Lock
        try {
            this.showSaveStatus(true, 'Saving color...');
            const newTimestamp = new Date().toISOString();
            const saveData = {
                colorData: this.terrainColors, // Save the merged state
                vertexCount: this.geometry.attributes.color.count, // Use actual vertex count
                timestamp: newTimestamp
            };

            if (this.canonicalColorRecordId) {
                // Update the existing record
                await this.room.collection('terrainColorState').update(this.canonicalColorRecordId, saveData);
                console.log(`Updated canonical color state record: ${this.canonicalColorRecordId}`);
                // Update local timestamp *after* successful save
                this.lastAppliedTimestamp = newTimestamp;
            } else {
                // Create the first canonical record (fallback)
                console.warn("Canonical color record ID not found during save attempt, creating new one...");
                const newRecord = await this.room.collection('terrainColorState').create(saveData);
                this.canonicalColorRecordId = newRecord.id; // Store the new ID
                this.lastAppliedTimestamp = newTimestamp; // Set timestamp for the newly created record
                console.log(`Created canonical color state record: ${this.canonicalColorRecordId}`);
            }

            this.showSaveStatus(false);

        } catch (error) {
            console.error('Error saving color state:', error);
            this.showSaveStatus(false, 'Error saving color!', true);
        } finally {
            this.currentStrokeColorChanges = {}; // Always clear stroke changes
            this.isProcessing = false; // Release lock
            console.log("Color save attempt finished, isProcessing set to false.");
        }
    }

    applyColorState(stateData) {
        // Avoid re-applying the same state based on timestamp
        if (stateData.timestamp && stateData.timestamp === this.lastAppliedTimestamp) {
            console.log("Skipping application of already current color state (Timestamp match).");
            return false;
        }
        // Ensure data is valid, default to empty object if not
        const colorData = (stateData && typeof stateData.colorData === 'object') ? stateData.colorData : {};

        console.log("Applying canonical color state...");
        const attributeExisted = this.ensureColorAttribute();
        const colorAttribute = this.geometry.attributes.color;
        let applied = false;

        // Directly replace local state with the loaded state
        // Create a new object reference
        this.terrainColors = { ...colorData };

        // Initialize all vertices, applying saved color or default if missing
        const defaultColorHex = this.colorPalette[0].hex; // Fallback color
        const defaultColor = new THREE.Color(defaultColorHex);
        const tempColor = new THREE.Color(); // Reuse for performance

        for (let i = 0; i < colorAttribute.count; i++) {
            const colorHex = this.terrainColors[i]; // Get color from the potentially sparse loaded data
            let appliedColor = defaultColor;
            let appliedHex = defaultColorHex;

            if (colorHex) {
                try {
                    tempColor.set(colorHex); // Attempt to set from loaded hex
                    appliedColor = tempColor;
                    appliedHex = colorHex;
                } catch (e) {
                    console.warn(`Invalid color hex "${colorHex}" at index ${i}. Applying default.`);
                    // Keep defaultColor and defaultColorHex
                }
            }

            // Check if the color actually needs changing
            const currentColor = tempColor.fromBufferAttribute(colorAttribute, i);
            if (currentColor.getHex() !== appliedColor.getHex()) {
                colorAttribute.setXYZ(i, appliedColor.r, appliedColor.g, appliedColor.b);
                applied = true; // Mark that a change occurred
            }

            // Ensure local cache matches exactly what's applied, including defaults
            // Store consistent hex format (lowercase)
            this.terrainColors[i] = '#' + appliedColor.getHexString();
        }


        if (applied || !attributeExisted) { // Force update if attribute was just created
            colorAttribute.needsUpdate = true;
            this.lastAppliedTimestamp = stateData.timestamp; // Track the timestamp of applied data
            console.log('Applied canonical color state to terrain geometry.');
            return true;
        } else {
            // Even if no vertices changed, update timestamp if the incoming state's timestamp is newer
            if (stateData.timestamp && (!this.lastAppliedTimestamp || stateData.timestamp > this.lastAppliedTimestamp)) {
                this.lastAppliedTimestamp = stateData.timestamp;
                console.log("Updated lastAppliedColorTimestamp even though geometry was already up-to-date.");
            }
            console.log('Color geometry was already up-to-date with the received state.');
            return false;
        }
    }

    async loadColorData() {
        this.isProcessing = true;
        try {
            console.log("Loading canonical color state...");
            this.ensureColorAttribute(); // Make sure attribute exists

            // Unsubscribe from previous listeners if any
            if (this.unsubscribe) {
                this.unsubscribe();
                this.unsubscribe = null;
                console.log("Unsubscribed from previous color state listener.");
            }

            // Fetch the list of state records (should ideally be just one)
            const states = await this.room.collection('terrainColorState').getList();
            let latestState = null;

            if (states.length > 0) {
                latestState = states[0]; // Get newest first
                this.canonicalColorRecordId = latestState.id; // Store the ID
                console.log('Found existing color state from record:', this.canonicalColorRecordId, 'Timestamp:', latestState.timestamp);
                this.applyColorState(latestState); // Apply initial state
            } else {
                console.log("No canonical color state found. Initializing with default colors and creating record.");
                await this.createDefaultColorStateRecord(); // Creates and saves the first record
            }

            // Subscribe to future updates of the canonical state record
            this.unsubscribe = this.room.collection('terrainColorState').subscribe((incomingStates) => {
                // Don't process updates during initial load or while saving/applying
                if (this.isProcessing) {
                    console.log("Skipping color subscription update while processing.");
                    return;
                }
                if (incomingStates.length > 0) {
                    const updatedState = incomingStates.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0]; // Get latest
                    // Check if the incoming state is genuinely newer than what we last applied
                    if (updatedState.id === this.canonicalColorRecordId && updatedState.timestamp !== this.lastAppliedTimestamp) {
                        this.isProcessing = true; // Lock
                        console.log(`Received updated color state via subscription (ID: ${updatedState.id}, TS: ${updatedState.timestamp}). Applying...`);
                        this.applyColorState(updatedState);
                        this.isProcessing = false; // Unlock
                    } else if (updatedState.id !== this.canonicalColorRecordId) {
                        console.warn(`Received color state for a different ID (${updatedState.id}) than expected (${this.canonicalColorRecordId}). Ignoring.`);
                    } else {
                        // Timestamp matched, likely an echo or already applied
                        // console.log("Skipping color subscription update: Timestamp matches last applied.");
                    }
                } else {
                    console.warn("Canonical color state subscription returned empty list. Record might be deleted.");
                    // Consider attempting recreation or signaling error
                }
            });

            console.log("Color state loading and subscription setup complete.");

        } catch (error) {
            console.error('Error loading color state:', error);
            this.initializeDefaultColorsLocally(); // Fallback to default locally on error
        } finally {
            this.isProcessing = false; // Mark loading as complete
            // Ensure geometry update after loading attempt
            if (this.geometry.attributes.color) {
                this.geometry.attributes.color.needsUpdate = true;
            }
            // Allow saving/processing now that initial load finished (or failed)
            // Set processing to false slightly later
            setTimeout(() => { this.isProcessing = false; }, 100);
            console.log("Color load complete, isProcessing set to false.");
        }
    }

    // Sets default colors locally without saving
    initializeDefaultColorsLocally() {
        this.ensureColorAttribute();
        const colorAttribute = this.geometry.attributes.color;
        const defaultColorHex = this.colorPalette[0].hex;
        const defaultColor = new THREE.Color(defaultColorHex);
        this.terrainColors = {}; // Reset local state
        let changed = false;
        for (let i = 0; i < colorAttribute.count; i++) {
            const currentColor = new THREE.Color().fromBufferAttribute(colorAttribute, i);
            if (currentColor.getHex() !== defaultColor.getHex()) {
                colorAttribute.setXYZ(i, defaultColor.r, defaultColor.g, defaultColor.b);
                changed = true;
            }
            this.terrainColors[i] = defaultColorHex; // Store default hex
        }
        if (changed && colorAttribute) colorAttribute.needsUpdate = true;
        console.log("Initialized terrain with default colors locally.");
    }

    // Creates the first color state record with default colors
    async createDefaultColorStateRecord() {
        console.log("Executing createDefaultColorStateRecord...");
        this.ensureColorAttribute();
        const colorAttribute = this.geometry.attributes.color;
        const defaultColorHex = this.colorPalette[0].hex;
        const defaultColor = new THREE.Color(defaultColorHex);
        const colorData = {};
        this.terrainColors = {}; // Reset local cache

        for (let i = 0; i < colorAttribute.count; i++) {
            colorAttribute.setXYZ(i, defaultColor.r, defaultColor.g, defaultColor.b);
            colorData[i] = defaultColorHex;
            this.terrainColors[i] = defaultColorHex; // Update local cache
        }

        colorAttribute.needsUpdate = true; // Mark geometry for update

        const newTimestamp = new Date().toISOString();
        const saveData = {
            colorData: colorData,
            vertexCount: colorAttribute.count,
            isInitial: true,
            timestamp: newTimestamp
        };

        try {
            const stateRecord = await this.room.collection('terrainColorState').create(saveData);
            this.canonicalColorRecordId = stateRecord.id; // Store ID
            this.lastAppliedTimestamp = newTimestamp; // Store timestamp
            console.log('Created and saved initial default color state record:', this.canonicalColorRecordId);
            return colorData;
        } catch (error) {
            console.error('Error creating default color state record:', error);
            this.canonicalColorRecordId = null;
            this.lastAppliedTimestamp = null;
            throw error;
        }
    }

    showSaveStatus(isVisible, message = 'Saving changes...', isError = false) {
        if (!this.statusElement) return;

        this.statusElement.textContent = message;
        this.statusElement.style.opacity = isVisible ? '1' : '0';
        this.statusElement.style.backgroundColor = isError ? 'rgba(220,53,69,0.7)' : 'rgba(0,0,0,0.7)';
        this.statusElement.style.color = isError ? 'white' : 'white';

        // Clear previous timeouts
        if (this.statusTimeout) {
            clearTimeout(this.statusTimeout);
            this.statusTimeout = null;
        }

        if (isVisible && !isError) {
            // Auto-hide for non-error messages
            this.statusTimeout = setTimeout(() => {
                if (this.statusElement.textContent === message && !isError) {
                    this.hideSaveStatus();
                }
            }, 1500);
        } else if (!isVisible) {
            // Manual hide
            if (this.statusTimeout) clearTimeout(this.statusTimeout);
            this.statusTimeout = null;
        }
        // Error messages remain visible until next status update
    }

    hideSaveStatus() {
        if (!this.statusElement) return;
        this.statusElement.style.opacity = '0';
        if (this.statusTimeout) {
            clearTimeout(this.statusTimeout);
            this.statusTimeout = null;
        }
    }
}