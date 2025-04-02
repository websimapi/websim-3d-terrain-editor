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
            { hex: '#66aa66', name: 'Grass Green' }, // Default grass
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
        this.currentColor = this.colorPalette[0].hex; // Default to grass
        // Track the ID of the single canonical color state record
        this.canonicalColorRecordId = null;
        // Track the timestamp of the currently applied color data to avoid loops
        this.lastAppliedTimestamp = null;
        // Flag to prevent saving while loading initial data
        this.isLoading = true;
        // Flag to track if initial state has been loaded/applied
        this.initialDataLoaded = false;
        this.unsubscribeColor = null; // To store unsubscribe function
        this.initialLoadTimeout = null; // Timeout handle
        this.COLLECTION_NAME = 'terrainColorState'; // Constant for collection name
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
        let attributeCreated = false;
        if (!this.geometry.attributes.color) {
            const colors = new Float32Array(this.geometry.attributes.position.count * 3);
            // Initialize with the default base color
            const defaultColor = new THREE.Color(this.colorPalette[0].hex); // Use grass green
            for (let i = 0; i < colors.length; i += 3) {
                colors[i] = defaultColor.r;
                colors[i + 1] = defaultColor.g;
                colors[i + 2] = defaultColor.b;
            }
            this.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
            console.log("Created initial color buffer attribute.");
            attributeCreated = true;
        }

        if (this.terrainMesh && this.terrainMesh.material && !this.terrainMesh.material.vertexColors) {
            this.terrainMesh.material.vertexColors = true;
            this.terrainMesh.material.needsUpdate = true;
            console.log("Enabled vertex colors on material.");
        }
        return attributeCreated; // Return true if the attribute was newly created
    }

    applyColorBrush(hitPoint, brushRadius, brushStrength) {
        this.ensureColorAttribute(); // Ensure attribute exists

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
                // Blend factor needs care - too high strength makes it instant paint
                const blendFactor = Math.min(falloff * (brushStrength * 0.1), 1.0); // Adjust strength factor, clamp at 1

                const existingColor = new THREE.Color();
                existingColor.fromBufferAttribute(colorAttribute, i);
                existingColor.lerp(targetColor, blendFactor);

                // Avoid tiny changes if possible (optional)
                // if (Math.abs(existingColor.r - colorAttribute.getX(i)) > 0.01 || ...)

                colorAttribute.setXYZ(i, existingColor.r, existingColor.g, existingColor.b);

                // Store the change for this stroke using the exact hex
                const newHex = '#' + existingColor.getHexString();
                this.currentStrokeColorChanges[i] = newHex;
                // Also update the canonical state cache immediately for consistency
                this.terrainColors[i] = newHex;

                colorModified = true;
            }
        }

        if (colorModified) {
            colorAttribute.needsUpdate = true;
            return true; // Indicate that the geometry was modified
        }
        return false;
    }

    async saveColorChanges() {
        // Prevent saving during initial load OR if initial data hasn't been confirmed yet
        if (this.isLoading || !this.initialDataLoaded) {
            console.log("Skipping color save: Still loading or initial data not confirmed.");
            return;
        }
        // Merge changes from the current stroke into the main state BEFORE checking if empty
        // Note: applyColorBrush now updates terrainColors directly, so merging isn't strictly needed
        // but we still check currentStrokeColorChanges to see if a save is warranted.
        let changesFromStroke = Object.keys(this.currentStrokeColorChanges).length > 0;
        if (!changesFromStroke) {
            console.log("No color changes accumulated in the current stroke.");
            // If there were no changes in the stroke, we don't need to save.
            this.currentStrokeColorChanges = {}; // Ensure it's clear
            return;
        }
        // Clear the stroke changes *before* attempting save, as terrainColors holds the merged state
        this.currentStrokeColorChanges = {};

        // Double check if terrainColors is actually populated
        if (Object.keys(this.terrainColors).length === 0) {
            console.warn("Attempted to save but terrainColors is empty. Aborting save.");
            return;
        }

        try {
            this.showSaveStatus(true, 'Saving color...');
            const currentTimestamp = new Date().toISOString();
            const saveData = {
                colorData: this.terrainColors, // Save the complete state
                vertexCount: this.geometry.attributes.color.count, // Use actual count
                timestamp: currentTimestamp
            };

            console.log(`Attempting to save color state. Record ID: ${this.canonicalColorRecordId}. Timestamp: ${currentTimestamp}`);

            if (this.canonicalColorRecordId) {
                // Update the existing record
                try {
                    await this.room.collection(this.COLLECTION_NAME).update(this.canonicalColorRecordId, saveData);
                    console.log(`Updated canonical color state record: ${this.canonicalColorRecordId}`);
                    this.lastAppliedTimestamp = currentTimestamp; // Update timestamp only on successful update
                } catch (updateError) {
                    console.error(`Failed to update color record ${this.canonicalColorRecordId}, attempting to create new. Error:`, updateError);
                    // If update failed (e.g., record deleted), try creating a new one
                    await this.createCanonicalRecord(saveData); // Use the same data
                }
            } else {
                // Create the first canonical record (or replacement)
                console.log("Canonical color record ID not found or update failed, creating new one...");
                await this.createCanonicalRecord(saveData);
            }

            this.showSaveStatus(false);

        } catch (error) {
            console.error('Error saving color state:', error);
            this.showSaveStatus(false, 'Error saving color!', true);
            // Clear stroke changes again just in case
            this.currentStrokeColorChanges = {};
        } finally {
            // Ensure stroke changes are cleared after attempt
            this.currentStrokeColorChanges = {};
        }
    }

    // Helper to create the canonical record and set state
    async createCanonicalRecord(saveData) {
        const newRecord = await this.room.collection(this.COLLECTION_NAME).create(saveData);
        this.canonicalColorRecordId = newRecord.id; // Store the new ID
        this.lastAppliedTimestamp = saveData.timestamp; // Set timestamp for the newly created record
        console.log(`Created/Replaced canonical color state record: ${this.canonicalColorRecordId}`);
        // Ensure initial load flag is set if this happens very early
        if (!this.initialDataLoaded) {
            this.initialDataLoaded = true;
            this.isLoading = false;
        }
    }

    applyColorState(stateData) {
        console.log(`Attempting to apply color state. Incoming TS: ${stateData?.timestamp}, Last Applied TS: ${this.lastAppliedTimestamp}`);
        if (!stateData || typeof stateData.colorData !== 'object') {
            console.error('Invalid color state data received:', stateData);
            stateData = { colorData: {}, timestamp: null }; // Use default empty data for reset
            // Ensure attribute exists even if resetting
            this.ensureColorAttribute();
        }
        // Avoid re-applying the same state received via subscription or initial load
        // Allow applying if canonical ID has changed even if timestamp is same (edge case)
        if (stateData.timestamp && stateData.timestamp === this.lastAppliedTimestamp && stateData.id === this.canonicalColorRecordId) {
            console.log(`Skipping application of color state: Timestamp ${stateData.timestamp} already applied for ID ${stateData.id}.`);
            return false; // Indicate no change was made
        }

        // If stateData doesn't have an ID (e.g., initial default creation), generate one for logging
        const stateIdForLog = stateData.id || '(local default)';
        console.log(`Applying canonical color state (ID: ${stateIdForLog}, TS: ${stateData.timestamp})...`);
        this.ensureColorAttribute(); // Ensure attribute exists and material uses vertex colors
        const colorAttribute = this.geometry.attributes.color;
        const loadedColorData = stateData.colorData || {};
        const numLoadedKeys = Object.keys(loadedColorData).length;
        console.log(`State contains ${numLoadedKeys} color entries.`);
        let verticesApplied = 0;
        let verticesDefaulted = 0;
        const defaultColor = new THREE.Color(this.colorPalette[0].hex); // Fallback color (Grass Green)
        const defaultColorHex = this.colorPalette[0].hex;

        // Clear current local state before applying the new one
        this.terrainColors = {};

        // Initialize all vertices, applying saved color or default if missing
        for (let i = 0; i < colorAttribute.count; i++) {
            const colorHex = loadedColorData[i];
            let appliedColorHex = defaultColorHex; // Assume default initially
            try {
                const color = colorHex ? new THREE.Color(colorHex) : defaultColor;
                colorAttribute.setXYZ(i, color.r, color.g, color.b);
                appliedColorHex = colorHex ? colorHex : defaultColorHex; // Track what was actually applied/cached
                if (colorHex) {
                    verticesApplied++;
                } else {
                    verticesDefaulted++;
                }
            } catch (e) {
                console.warn(`Invalid color hex '${colorHex}' at index ${i}. Applying default (${defaultColorHex}).`);
                colorAttribute.setXYZ(i, defaultColor.r, defaultColor.g, defaultColor.b);
                verticesDefaulted++;
                appliedColorHex = defaultColorHex;
            }
            // Ensure local cache matches exactly what's applied, including defaults
            this.terrainColors[i] = appliedColorHex;
        }

        console.log(`Applied color state: ${verticesApplied} vertices from data, ${verticesDefaulted} defaulted to ${defaultColorHex}.`);
        colorAttribute.needsUpdate = true; // Mark buffer for update
        if (stateData.timestamp) {
            this.lastAppliedTimestamp = stateData.timestamp; // Track the timestamp of applied data
        }
        // If applying state from a record, update the canonical ID
        if (stateData.id) {
            this.canonicalColorRecordId = stateData.id;
        }
        return true; // Indicate state was applied
    }

    async loadColorData() {
        console.log(`Initiating ${this.COLLECTION_NAME} loading...`);
        this.isLoading = true;
        this.initialDataLoaded = false;
        this.canonicalColorRecordId = null;
        this.lastAppliedTimestamp = null;
        if (this.unsubscribeColor) this.unsubscribeColor();
        if (this.initialLoadTimeout) clearTimeout(this.initialLoadTimeout);

        this.ensureColorAttribute(); // Make sure attribute exists BEFORE loading/applying data

        console.log(`Subscribing to ${this.COLLECTION_NAME} collection...`);
        this.unsubscribeColor = this.room.collection(this.COLLECTION_NAME).subscribe(async (states) => {
            console.log(`${this.COLLECTION_NAME} subscription triggered. Received ${states.length} states. Initial load done: ${this.initialDataLoaded}`);
            if (this.initialLoadTimeout) clearTimeout(this.initialLoadTimeout); // Clear timeout if subscription fires

            if (!this.initialDataLoaded) {
                // First data received from subscription
                this.initialDataLoaded = true; // Mark that we received *something* (even empty)
                if (states.length > 0) {
                    // Find the canonical state (newest)
                    const latestState = states.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
                    console.log(`Applying initial canonical ${this.COLLECTION_NAME} state: ID=${latestState.id}, TS=${latestState.timestamp}`);
                    this.applyColorState(latestState); // Apply it (this sets canonical ID and timestamp)
                    this.isLoading = false; // Allow saving now
                } else {
                    // Subscription fired but was empty - means no records exist. Create default.
                    console.log(`Initial subscription for ${this.COLLECTION_NAME} returned empty. Creating default record.`);
                    try {
                        await this.initializeDefaultColorsAndSave();
                        console.log(`Default ${this.COLLECTION_NAME} record created successfully.`);
                    } catch (creationError) {
                        console.error(`Failed to create initial ${this.COLLECTION_NAME} record`, creationError);
                        this.initializeDefaultColors(true); // Apply default locally as fallback
                    } finally {
                        this.isLoading = false;
                        if (this.geometry.attributes.color) {
                            this.geometry.attributes.color.needsUpdate = true;
                        }
                    }
                }
                console.log(`${this.COLLECTION_NAME} initial load processing finished. isLoading: ${this.isLoading}`);
                // Ensure geometry update after initial load/creation attempt
                if (this.geometry.attributes.color) {
                    this.geometry.attributes.color.needsUpdate = true;
                }

            } else {
                // Update received after initial load
                if (states.length > 0) {
                    const updatedState = states.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
                    console.log(`Processing ${this.COLLECTION_NAME} update: ID=${updatedState.id}, Timestamp=${updatedState.timestamp}, CurrentCanonicalID=${this.canonicalColorRecordId}, LastAppliedTS=${this.lastAppliedTimestamp}`);

                    // Apply if it's a new state (different timestamp) for the canonical record OR if the canonical ID somehow changed
                    if (updatedState.id === this.canonicalColorRecordId && updatedState.timestamp !== this.lastAppliedTimestamp) {
                        console.log(`Applying updated ${this.COLLECTION_NAME} state via subscription (ID: ${updatedState.id}, TS: ${updatedState.timestamp})`);
                        if (this.applyColorState(updatedState)) {
                            console.log(`Geometry color updated from ${this.COLLECTION_NAME} subscription.`);
                        }
                    } else if (updatedState.id !== this.canonicalColorRecordId) {
                        console.warn(`Canonical ${this.COLLECTION_NAME} record ID changed from ${this.canonicalColorRecordId} to ${updatedState.id}. Applying new state.`);
                        if (this.applyColorState(updatedState)) { // applyState handles setting new canonical ID
                            console.log(`Geometry color updated from new canonical ${this.COLLECTION_NAME} ID.`);
                        }
                    } else {
                        console.log(`Skipping ${this.COLLECTION_NAME} update: Same timestamp or non-canonical ID.`);
                    }
                } else {
                    console.warn(`Canonical ${this.COLLECTION_NAME} subscription returned empty list after initial load. Record might be deleted.`);
                    this.canonicalColorRecordId = null; // Clear the ID
                    this.lastAppliedTimestamp = null;
                    // Optionally reset to default colors here? Or wait for user action.
                    // this.initializeDefaultColors(true);
                }
            }
        });

        // Timeout as a fallback in case subscription doesn't fire quickly
        this.initialLoadTimeout = setTimeout(async () => {
            console.log(`${this.COLLECTION_NAME}: Checking initial load status after timeout.`);
            if (!this.initialDataLoaded) {
                console.warn(`${this.COLLECTION_NAME}: Initial data not received via subscription after timeout. Attempting to create default record.`);
                this.initialDataLoaded = true; // Mark as handled (attempted)
                try {
                    await this.initializeDefaultColorsAndSave();
                    console.log(`Default ${this.COLLECTION_NAME} record created successfully after timeout.`);
                } catch (err) {
                    console.error(`Failed to create default ${this.COLLECTION_NAME} record after timeout`, err);
                    this.initializeDefaultColors(true); // Apply default locally as fallback
                } finally {
                    this.isLoading = false;
                    if (this.geometry.attributes.color) {
                        this.geometry.attributes.color.needsUpdate = true;
                    }
                }
            }
        }, 5000); // 5 second timeout
    }

    // Initialize local cache and geometry with default colors
    initializeDefaultColors(forceApplyToGeometry = false) {
        const attributeExisted = !!this.geometry.attributes.color;
        const attributeCreated = this.ensureColorAttribute(); // Ensures attribute exists
        const applyToGeometry = forceApplyToGeometry || attributeCreated;

        console.log(`Initializing default colors. Force apply: ${forceApplyToGeometry}, Attribute created now: ${attributeCreated}`);

        const colorAttribute = this.geometry.attributes.color;
        const defaultColor = new THREE.Color(this.colorPalette[0].hex); // Use first palette color
        const defaultColorHex = this.colorPalette[0].hex;
        this.terrainColors = {}; // Reset local state

        for (let i = 0; i < colorAttribute.count; i++) {
            if (applyToGeometry) {
                colorAttribute.setXYZ(i, defaultColor.r, defaultColor.g, defaultColor.b);
            }
            this.terrainColors[i] = defaultColorHex; // Update local cache regardless
        }

        if (applyToGeometry && colorAttribute) {
            colorAttribute.needsUpdate = true;
            console.log("Applied default colors to geometry buffer.");
        }
        console.log(`Initialized local terrainColors cache with default color: ${defaultColorHex}`);
    }

    // New method: Initialize default colors AND save them as the first canonical record
    async initializeDefaultColorsAndSave() {
        console.log(`Initializing default ${this.COLLECTION_NAME} state and creating first record...`);
        this.initializeDefaultColors(true); // Apply default colors locally and to geometry

        const currentTimestamp = new Date().toISOString();
        const saveData = {
            colorData: this.terrainColors,
            vertexCount: this.geometry.attributes.color.count,
            timestamp: currentTimestamp,
            isInitial: true // Mark as the first default state
        };

        // Create the canonical record
        await this.createCanonicalRecord(saveData);
        // No need to call showSaveStatus here, it's part of initialization
    }

    showSaveStatus(isVisible, message = 'Saving color...', isError = false) {
        if (!this.statusElement) return;
        // Combine messages if both height/color are saving? Maybe not needed. Use specific messages.
        this.statusElement.textContent = message; // Use passed message directly
        this.statusElement.style.opacity = isVisible ? '1' : '0';
        this.statusElement.style.backgroundColor = isError ? 'rgba(220,53,69,0.7)' : 'rgba(0,0,0,0.7)';
        if (isVisible && !isError) {
            // Automatically hide after a short delay
            setTimeout(() => {
                // Check if the message is still the *same saving* message before hiding
                // Allows error messages or subsequent saving messages to persist
                if (this.statusElement.textContent === message && !isError) {
                    this.statusElement.style.opacity = '0';
                }
            }, 1500);
        }
    }
}