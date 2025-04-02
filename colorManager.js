import * as THREE from 'three';

export class ColorManager {
    constructor(room, geometry, scene) {
        this.room = room;
        this.geometry = geometry;
        this.scene = scene;
        this.terrainMesh = scene.getObjectByName('terrain');
        this.colorChanges = {};
        this.terrainColors = {};
        this.statusElement = document.getElementById('save-status');
        this.userColorRowId = null; // Store the user's color row ID
        
        // Color palette
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
        this.allColorChanges = {};
        this.myUsername = '';
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
            
            // Mark the first color as active by default
            if (color.hex === this.currentColor) {
                swatch.classList.add('active');
            }
            
            swatch.addEventListener('click', (e) => {
                // Prevent brush application when clicking color
                e.stopPropagation();
                
                // Update active swatch
                document.querySelectorAll('.color-swatch').forEach(s => {
                    s.classList.remove('active');
                });
                swatch.classList.add('active');
                
                // Update current color
                this.currentColor = color.hex;
                
                // Trigger event for main.js to handle
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
            // Initialize with default terrain color (light green)
            for (let i = 0; i < colors.length; i += 3) {
                colors[i] = 0.4;     // R
                colors[i + 1] = 0.6;  // G
                colors[i + 2] = 0.4;  // B
            }
            this.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        }
        
        // Enable vertex colors on the material
        if (this.terrainMesh && this.terrainMesh.material) {
            this.terrainMesh.material.vertexColors = true;
            this.terrainMesh.material.needsUpdate = true;
        }
    }

    applyColorBrush(hitPoint, brushRadius, brushStrength) {
        this.ensureColorAttribute();
        
        const positions = this.geometry.attributes.position;
        const colorAttribute = this.geometry.attributes.color;
        const vertex = new THREE.Vector3();
        let colorModified = false;

        // Apply color to vertices within brush radius
        for (let i = 0; i < positions.count; i++) {
            vertex.fromBufferAttribute(positions, i);
            // Calculate distance in the XZ plane for cylindrical brush effect
            const dx = vertex.x - hitPoint.x;
            const dz = vertex.z - hitPoint.z;
            const distance = Math.sqrt(dx * dx + dz * dz);

            if (distance < brushRadius) {
                // Smoother falloff using cosine function
                const falloff = Math.cos((distance / brushRadius) * Math.PI / 2);
                
                // Apply color with falloff for blending
                const color = new THREE.Color(this.currentColor);
                
                // If we already have a color, blend with existing
                const existingColor = new THREE.Color();
                existingColor.fromBufferAttribute(colorAttribute, i);
                
                // Lerp between existing and new color based on falloff and strength
                const blendFactor = falloff * (brushStrength / 5);
                existingColor.lerp(color, blendFactor);
                
                // Apply the color
                colorAttribute.setXYZ(i, existingColor.r, existingColor.g, existingColor.b);
                
                // Store the color change for database
                this.colorChanges[i] = '#' + existingColor.getHexString();
                
                colorModified = true;
            }
        }
        
        // If colors were modified, update the color attribute
        if (colorModified) {
            colorAttribute.needsUpdate = true;
            return true;
        }
        
        return false;
    }

    async loadColorData() {
        try {
            this.myUsername = this.room.peers[this.room.clientId].username;
            
            // Get all users' color data
            const userColorRows = await this.room.collection('userColorData').getList();
            
            // Debug logging of all color rows and usernames
            console.log('Current user (colors):', this.myUsername);
            console.log('All color rows:', userColorRows.map(row => ({
                id: row.id,
                username: row.username,
                changeCount: row.colorData ? Object.keys(row.colorData).length : 0
            })));
            
            // Find this user's row or create if it doesn't exist
            let userRow = userColorRows.find(row => row.username === this.myUsername);
            
            if (userRow) {
                console.log(`Found existing color row for user ${this.myUsername} with ID ${userRow.id}`);
                this.userColorRowId = userRow.id;
            } else {
                console.log(`No color row found for user ${this.myUsername}, creating new row`);
                userRow = await this.room.collection('userColorData').create({
                    colorData: {},
                    changeCount: 0,
                    lastModified: new Date().toISOString()
                });
                this.userColorRowId = userRow.id;
                console.log(`Created new color row with ID ${this.userColorRowId}`);
            }
            
            // Apply all users' color data
            userColorRows.forEach(row => {
                if (row.colorData && Object.keys(row.colorData).length > 0) {
                    this.applyColorDataToTerrain(row.colorData);
                }
            });
            
            // Subscribe to changes in the userColorData collection
            this.room.collection('userColorData').subscribe((rows) => {
                // Process each user's changes
                rows.forEach(row => {
                    // Skip our own row as we manage it directly
                    if (row.id === this.userColorRowId) return;
                    
                    // Apply the color changes from other users
                    if (row.colorData) {
                        this.applyColorDataToTerrain(row.colorData);
                    }
                });
            });
            
        } catch (error) {
            console.error('Error loading color data:', error);
        }
    }

    async saveColorChanges() {
        if (Object.keys(this.colorChanges).length === 0) return;
        
        try {
            this.showSaveStatus(true);
            
            // Update our local state
            this.terrainColors = {...this.terrainColors, ...this.colorChanges};
            
            // Save color data to user's row
            if (this.userColorRowId) {
                // Get the current user row
                let userRow = await this.room.collection('userColorData').filter({id: this.userColorRowId}).getList();
                console.log(`Looking for color row with ID ${this.userColorRowId}`, userRow);
                
                if (userRow && userRow.length > 0) {
                    // Update existing row with merged color changes
                    const existingColors = userRow[0].colorData || {};
                    const mergedColors = {...existingColors, ...this.colorChanges};
                    
                    console.log(`Updating color row ${this.userColorRowId} for user ${this.myUsername}`);
                    await this.room.collection('userColorData').update(this.userColorRowId, {
                        colorData: mergedColors,
                        changeCount: Object.keys(mergedColors).length,
                        lastModified: new Date().toISOString()
                    });
                } else {
                    console.warn(`User color row with ID ${this.userColorRowId} not found, creating a new one`);
                    // Get latest rows to check what's in the database
                    const allRows = await this.room.collection('userColorData').getList();
                    console.log('Current color database rows:', allRows.map(r => ({ id: r.id, username: r.username })));
                    
                    const newRow = await this.room.collection('userColorData').create({
                        colorData: this.colorChanges,
                        changeCount: Object.keys(this.colorChanges).length,
                        lastModified: new Date().toISOString()
                    });
                    this.userColorRowId = newRow.id;
                    console.log(`Created new color row with ID ${this.userColorRowId}`);
                }
            } else {
                // Create a new row for this user
                const newRow = await this.room.collection('userColorData').create({
                    colorData: this.colorChanges,
                    changeCount: Object.keys(this.colorChanges).length,
                    lastModified: new Date().toISOString()
                });
                this.userColorRowId = newRow.id;
            }
            
            // Reset changes after saving
            const savedChanges = {...this.colorChanges};
            this.colorChanges = {};
            
            this.showSaveStatus(false);
            return savedChanges;
        } catch (error) {
            console.error('Error saving color changes:', error);
            this.showSaveStatus(false, true);
            return null;
        }
    }

    applyColorDataToTerrain(colorData) {
        if (!colorData || typeof colorData !== 'object') {
            console.error('Invalid color data:', colorData);
            return;
        }
        
        // Store colors locally
        this.terrainColors = {...this.terrainColors, ...colorData};
        
        // Ensure color attribute exists
        this.ensureColorAttribute();
        
        // Update colors based on received data
        const colorAttribute = this.geometry.attributes.color;
        let colorModified = false;
        
        for (const [vertexIndex, colorHex] of Object.entries(colorData)) {
            const i = parseInt(vertexIndex);
            if (isNaN(i) || i < 0 || i >= colorAttribute.count) continue;
            
            // Convert hex to RGB (0-1 range)
            const color = new THREE.Color(colorHex);
            colorAttribute.setXYZ(i, color.r, color.g, color.b);
            colorModified = true;
        }
        
        if (colorModified) {
            colorAttribute.needsUpdate = true;
            console.log('Applied color data to terrain');
        }
    }

    showSaveStatus(isVisible, isError = false) {
        if (!this.statusElement) return;
        
        this.statusElement.textContent = isError ? 'Error saving changes!' : 'Saving changes...';
        this.statusElement.style.opacity = isVisible ? '1' : '0';
        this.statusElement.style.backgroundColor = isError ? 'rgba(220,53,69,0.7)' : 'rgba(0,0,0,0.7)';
        
        if (isVisible && !isError) {
            setTimeout(() => {
                this.statusElement.style.opacity = '0';
            }, 1500);
        }
    }
}