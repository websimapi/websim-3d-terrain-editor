// Utility class to handle CORS proxies for textures
export class CorsProxyHandler {
    constructor() {
        this.proxiedUrls = new Map(); // Cache for already proxied URLs
        this.proxies = [
            "https://cors-anywhere.herokuapp.com/",
            "https://api.allorigins.win/raw?url=",
            "https://thingproxy.freeboard.io/fetch/",
            "https://everyorigin.vercel.app/raw?url=",
            "https://crossorigin.me/"
        ];
        this.currentProxyIndex = 0;
    }

    // Check if URL is already proxied
    isProxied(url) {
        return this.proxies.some(proxy => url.startsWith(proxy));
    }

    // Get a cached proxied URL or create a new one
    getProxiedUrl(originalUrl) {
        // If URL is already proxied, return it as is
        if (this.isProxied(originalUrl)) {
            return originalUrl;
        }

        // Check if we already have a proxied version cached
        if (this.proxiedUrls.has(originalUrl)) {
            return this.proxiedUrls.get(originalUrl);
        }

        // Create a new proxied URL
        const proxy = this.proxies[this.currentProxyIndex];
        const proxiedUrl = proxy + encodeURIComponent(originalUrl);
        
        // Cache it
        this.proxiedUrls.set(originalUrl, proxiedUrl);
        
        // Rotate to next proxy for load balancing
        this.currentProxyIndex = (this.currentProxyIndex + 1) % this.proxies.length;
        
        return proxiedUrl;
    }
}