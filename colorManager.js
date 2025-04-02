import * as THREE from 'three';

// Use a new collection name
const TERRAIN_COLOR_COLLECTION = 'terrainColor_v2';

export class ColorManager {
    constructor(room, geometry, scene) {
        this.room = room;
        this.geometry = geometry;
        this.scene = scene;
        this.terrainMesh = scene.getObjectByName('terrain');
        this.statusElement = document.getElementById('save-status'); // Reuse status element
        this.myUsername = '';
        this.myRecordId = null;
        // Stores the complete color data for the current user
        this.currentUserColorData = {}; // { vertexIndex: hexColorString }
        // Stores the merged color data from all users
        this.mergedTerrainColorData = {};
        this.isSaving = false;
        this.saveQueued = false;
        this.unsubscribe = null;

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
        this.currentColor = this.colorPalette[0].hex; // Default selected color
    }

    async initialize() {
        // Ensure we have the username before proceeding
        while (!this.room.clientId || !this.room.peers[this.room.clientId]) {
            console.log("Waiting for room client ID and peer info...");
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        this.myUsername = this.room.peers[this.room.clientId].username;
         if (!this.myUsername) {
             console.error("Failed to get username, cannot initialize ColorManager correctly.");
             return;
         }
        console.log(`ColorManager initializing for user: ${this.myUsername}`);
        this.initializeColorPalette(); // Setup UI
        this.ensureColorAttribute(); // Ensure geometry attribute exists
        await this.loadAndMergeAllColorData();
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
            const defaultColor = new THREE.Color(this.colorPalette[0].hex);
            for (let i = 0; i < colors.length; i += 3) {
                colors[i] = defaultColor.r;
                colors[i + 1] = defaultColor.g;
                colors[i + 2] = defaultColor.b;
            }
            this.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
            console.log("Created initial color buffer attribute.");
        }

        // Ensure material uses vertex colors
        if (this.terrainMesh && this.terrainMesh.material && !this.terrainMesh.material.vertexColors) {
            this.terrainMesh.material.vertexColors = true;
            this.terrainMesh.material.needsUpdate = true;
            console.log("Enabled vertex colors on material.");
        } else if (this.terrainMesh && this.terrainMesh.material) {
             // Ensure it stays true if it was already set
             this.terrainMesh.material.vertexColors = true;
        }
    }

    // Called during brush application by main.js
    applyColorChange(index, colorHex) {
        const indexStr = String(index);
        // Directly modify the user's local data copy
        this.currentUserColorData[indexStr] = colorHex;
        // Also update the merged data immediately for visual feedback
        this.mergedTerrainColorData[indexStr] = colorHex;

        // Apply to geometry buffer for immediate feedback
        const colorAttribute = this.geometry.attributes.color;
        if (colorAttribute) {
            try {
                const color = new THREE.Color(colorHex);
                colorAttribute.setXYZ(index, color.r, color.g, color.b);
                colorAttribute.needsUpdate = true; // Could optimize this
            } catch (e) {
                console.warn(`Invalid color hex ${colorHex} at index ${index} during applyColorChange.`);
            }
        }
    }

    // Load all user records, merge them, apply to geometry, and subscribe
    async loadAndMergeAllColorData() {
         try {
             console.log(`Loading all terrain data from ${TERRAIN_COLOR_COLLECTION}...`);
             if (this.unsubscribe) {
                 this.unsubscribe(); // Unsubscribe from previous listener
                 this.unsubscribe = null;
                 console.log("Unsubscribed from previous terrain color listener.");
             }

             const allRecords = await this.room.collection(TERRAIN_COLOR_COLLECTION).getList();
             console.log(`Found ${allRecords.length} color records.`);

             this.mergeColorRecords(allRecords);

             // Find or initialize current user's record data
             const myRecord = allRecords.find(r => r.username === this.myUsername);
             if (myRecord) {
                 console.log("Found existing color record for user:", this.myUsername);
                 this.myRecordId = myRecord.id;
                 this.currentUserColorData = { ...(myRecord.colorData || {}) };
                 // Re-merge after finding user record to ensure consistency
                 this.mergeColorRecords(allRecords);
             } else {
                 console.log("No existing color record for user, will create on first save.");
                 this.myRecordId = null;
                 // Initialize with default color
                 const defaultColorHex = this.colorPalette[0].hex;
                 const colorAttribute = this.geometry.attributes.color;
                 this.currentUserColorData = {};
                 if (colorAttribute) {
                      for (let i = 0; i < colorAttribute.count; i++) {
                          this.currentUserColorData[String(i)] = defaultColorHex;
                      }
                 }
             }

             this.applyMergedColorDataToGeometry();

             // Subscribe to future changes
             this.unsubscribe = this.room.collection(TERRAIN_COLOR_COLLECTION).subscribe((updatedRecords) => {
                 console.log(`Subscription update: Received ${updatedRecords.length} color records.`);
                 const myNewRecord = updatedRecords.find(r => r.username === this.myUsername);
                 this.myRecordId = myNewRecord ? myNewRecord.id : null;
                 if (myNewRecord && !this.isSaving) { // Avoid overwriting local changes
                     this.currentUserColorData = { ...(myNewRecord.colorData || {}) };
                 }
                 this.mergeColorRecords(updatedRecords);
                 this.applyMergedColorDataToGeometry();
             });
             console.log(`Subscribed to ${TERRAIN_COLOR_COLLECTION} updates.`);

         } catch (error) {
             console.error('Error loading and merging terrain color data:', error);
         }
    }

    // Merge data from multiple color records (last update wins per vertex)
    mergeColorRecords(records) {
        console.log(`Merging ${records.length} color records...`);
        const newMergedData = {};
        const lastUpdatePerVertex = {}; // { vertexIndex: timestamp_ms } - Not strictly needed with simple overwrite

        // Sort records by update time (oldest first)
        const sortedRecords = records.sort((a, b) => {
            const timeA = new Date(a.created_at).getTime(); // Use created_at
            const timeB = new Date(b.created_at).getTime();
            return timeA - timeB;
        });

        const defaultColorHex = this.colorPalette[0].hex; // Fallback color

        for (const record of sortedRecords) {
            if (!record.colorData || typeof record.colorData !== 'object') continue;
            // const recordTimestamp = new Date(record.created_at).getTime(); // Use created_at

            for (const [indexStr, colorHex] of Object.entries(record.colorData)) {
                 newMergedData[indexStr] = colorHex || defaultColorHex; // Simple overwrite due to sorting
            }
        }
        this.mergedTerrainColorData = newMergedData;
         console.log(`Color merging complete. Merged vertices: ${Object.keys(this.mergedTerrainColorData).length}`);
    }

    // Apply the merged color data to the Three.js geometry
    applyMergedColorDataToGeometry() {
        console.log("Applying merged color data to geometry...");
        this.ensureColorAttribute(); // Make sure attribute and material setting are correct
        const colorAttribute = this.geometry.attributes.color;
        if (!colorAttribute) {
            console.error("Cannot apply color data, color attribute missing.");
            return;
        }

        let vertexModified = false;
        const defaultColor = new THREE.Color(this.colorPalette[0].hex); // Fallback color

        for (let i = 0; i < colorAttribute.count; i++) {
            const indexStr = String(i);
            const targetColorHex = this.mergedTerrainColorData[indexStr];
            const targetColor = new THREE.Color();

            try {
                targetColor.set(targetColorHex || defaultColor); // Use default if missing or invalid
            } catch (e) {
                console.warn(`Invalid color hex '${targetColorHex}' for index ${i}, using default.`);
                targetColor.copy(defaultColor);
            }

            // Check if color differs significantly before setting
            const currentColor = new THREE.Color().fromBufferAttribute(colorAttribute, i);
            if (!currentColor.equals(targetColor)) {
                 colorAttribute.setXYZ(i, targetColor.r, targetColor.g, targetColor.b);
                 vertexModified = true;
            }
             // Ensure currentUserColorData also reflects the initial merged state
             if (this.currentUserColorData[indexStr] === undefined) {
                 this.currentUserColorData[indexStr] = targetColorHex || this.colorPalette[0].hex;
             }
        }

        if (vertexModified) {
            colorAttribute.needsUpdate = true;
            console.log('Geometry updated with merged color data.');
        } else {
             console.log('Geometry already up-to-date with merged color data.');
        }
    }

    // Save the user's complete terrain color data
    async saveColorData() {
        if (this.isSaving) {
            console.log("Color save already in progress, queueing next save.");
            this.saveQueued = true;
            return;
        }
         if (!this.myUsername) {
             console.error("Cannot save color changes, username is not set.");
             return;
         }

        this.isSaving = true;
        this.showSaveStatus(true, 'Saving color...');
        console.log("Attempting to save terrain color changes for user:", this.myUsername);

        const dataToSave = { ...this.currentUserColorData };
        const vertexCount = Object.keys(dataToSave).length;
        const updateTimestamp = new Date().toISOString();

        try {
            if (this.myRecordId) {
                // Update existing record
                 console.log(`Updating color record ${this.myRecordId} for ${this.myUsername}`);
                await this.room.collection(TERRAIN_COLOR_COLLECTION).update(this.myRecordId, {
                    colorData: dataToSave,
                    vertexCount: vertexCount,
                    updated_at: updateTimestamp
                });
                 console.log(`Successfully updated color record ${this.myRecordId}`);
            } else {
                // Create new record
                 console.log(`Creating new color record for ${this.myUsername}`);
                 const newRecord = await this.room.collection(TERRAIN_COLOR_COLLECTION).create({
                     colorData: dataToSave,
                     vertexCount: vertexCount,
                     updated_at: updateTimestamp
                 });
                 this.myRecordId = newRecord.id;
                 console.log(`Successfully created new color record ${this.myRecordId}`);
            }
            this.showSaveStatus(false);
        } catch (error) {
            console.error(`Error saving terrain color data for ${this.myUsername}:`, error);
            this.showSaveStatus(true, 'Error saving color!', true);
            setTimeout(() => this.showSaveStatus(false), 3000);
        } finally {
            this.isSaving = false;
             if (this.saveQueued) {
                 this.saveQueued = false;
                 console.log("Processing queued color save request.");
                 setTimeout(() => this.saveColorData(), 100);
             }
        }
    }

    // Show save status indicator
    showSaveStatus(isVisible, message = 'Saving changes...', isError = false) {
        if (!this.statusElement) return;

        this.statusElement.textContent = message;
        this.statusElement.style.opacity = isVisible ? '1' : '0';
        this.statusElement.style.backgroundColor = isError ? 'rgba(220,53,69,0.7)' : 'rgba(0,0,0,0.7)';

        // Auto-hide for non-error messages after a delay
        if (isVisible && !isError) {
            setTimeout(() => {
                // Only hide if the status hasn't changed (e.g., to an error)
                if (this.statusElement.textContent === message && !this.isSaving && !isError) {
                   this.statusElement.style.opacity = '0';
                }
            }, 1500);
        }
         // Don't auto-hide error messages
    }

    dispose() {
         if (this.unsubscribe) {
             this.unsubscribe();
             this.unsubscribe = null;
             console.log("Unsubscribed from terrain color updates on dispose.");
         }
    }
}