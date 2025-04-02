import * as THREE from 'three';

export class PlayerManager {
    constructor(room, scene) {
        this.room = room;
        this.scene = scene;
        this.playerMarkers = {};
        this.myUsername = '';
    }

    initialize() {
        this.myUsername = this.room.peers[this.room.clientId].username;
        console.log(`Player manager initialized for ${this.myUsername}`);
        
        // Subscribe to presence updates (other players joining/leaving)
        this.room.subscribePresence(this.updatePlayersList.bind(this));
    }

    // Update and display the list of connected players
    updatePlayersList(presence) {
        const playersContainer = document.getElementById('players-container');
        playersContainer.innerHTML = '';
        
        Object.keys(this.room.peers).forEach(clientId => {
            const peer = this.room.peers[clientId];
            const playerDiv = document.createElement('div');
            playerDiv.className = 'player-item';
            
            const avatar = document.createElement('img');
            avatar.className = 'player-avatar';
            avatar.src = `https://images.websim.ai/avatar/${peer.username}`;
            
            const nameSpan = document.createElement('span');
            nameSpan.className = 'player-name';
            nameSpan.textContent = peer.username;
            
            if (peer.id === this.room.clientId) {
                nameSpan.textContent += ' (You)';
            }
            
            playerDiv.appendChild(avatar);
            playerDiv.appendChild(nameSpan);
            playersContainer.appendChild(playerDiv);
        });
    }

    // Update player position in the shared presence
    updatePlayerPosition(camera, controls) {
        if (controls.target && camera.position) {
            this.room.updatePresence({
                position: {
                    x: camera.position.x,
                    y: camera.position.y,
                    z: camera.position.z
                },
                target: {
                    x: controls.target.x,
                    y: controls.target.y,
                    z: controls.target.z
                }
            });
        }
    }

    renderPlayerPositions() {
        // Remove markers for disconnected players
        Object.keys(this.playerMarkers).forEach(clientId => {
            if (!this.room.presence[clientId]) {
                this.scene.remove(this.playerMarkers[clientId]);
                delete this.playerMarkers[clientId];
            }
        });
        
        // Update or create markers for connected players
        Object.keys(this.room.presence).forEach(clientId => {
            if (clientId === this.room.clientId) return; // Skip self
            
            const playerData = this.room.presence[clientId];
            if (!playerData.position) return; // Skip if no position data yet
            
            // Create marker if it doesn't exist
            if (!this.playerMarkers[clientId]) {
                const markerGeometry = new THREE.ConeGeometry(1, 2, 8);
                const markerMaterial = new THREE.MeshBasicMaterial({ 
                    color: 0xff0000,
                    wireframe: true
                });
                this.playerMarkers[clientId] = new THREE.Mesh(markerGeometry, markerMaterial);
                this.scene.add(this.playerMarkers[clientId]);
            }
            
            // Update marker position
            const marker = this.playerMarkers[clientId];
            marker.position.set(
                playerData.position.x, 
                playerData.position.y, 
                playerData.position.z
            );
            
            // Point marker toward camera target if available
            if (playerData.target) {
                marker.lookAt(
                    playerData.target.x,
                    playerData.target.y,
                    playerData.target.z
                );
            }
        });
    }
}