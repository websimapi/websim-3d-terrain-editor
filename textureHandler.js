import * as THREE from 'three';
import { CorsProxyHandler } from './corsProxyHandler.js';

export class TextureHandler {
    constructor() {
        this.textureCache = new Map();
        this.corsProxyHandler = new CorsProxyHandler();
    }

    isTextureUrl(value) {
        return typeof value === 'string' && (
            value.startsWith('http://') || 
            value.startsWith('https://') || 
            value.startsWith('data:image')
        );
    }

    async loadTexture(url) {
        // First check if we already have this texture
        if (this.textureCache.has(url)) {
            return this.textureCache.get(url);
        }
        
        // If it's an external URL (not data URL), use proxy
        let textureUrl = url;
        if (url.startsWith('http') && !url.startsWith('data:')) {
            textureUrl = this.corsProxyHandler.getProxiedUrl(url);
        }

        return new Promise((resolve, reject) => {
            const loader = new THREE.TextureLoader();
            loader.crossOrigin = 'anonymous'; // Ensure cross-origin is set
            
            loader.load(
                textureUrl,
                (texture) => {
                    // Store both the original URL and proxied URL in cache
                    this.textureCache.set(url, texture);
                    if (textureUrl !== url) {
                        this.textureCache.set(textureUrl, texture);
                    }
                    resolve(texture);
                },
                undefined,
                (error) => {
                    console.error('Error loading texture:', error, textureUrl);
                    reject(error);
                }
            );
        });
    }

    getColorOrTexture(value) {
        if (this.isTextureUrl(value)) {
            return { isTexture: true, url: value };
        } else {
            return { isTexture: false, color: new THREE.Color(value) };
        }
    }

    applyToMaterial(material, value) {
        const result = this.getColorOrTexture(value);
        
        if (result.isTexture) {
            this.loadTexture(result.url).then(texture => {
                if (material.map) material.map.dispose();
                material.map = texture;
                material.color.set(0xFFFFFF); // Reset color to white for textures
                material.needsUpdate = true;
            }).catch(err => console.error("Error loading texture:", err));
            return true;
        } else {
            if (material.map) {
                material.map.dispose();
                material.map = null;
            }
            material.color.copy(result.color);
            material.needsUpdate = true;
            return false; // Not a texture
        }
    }
}