/**
 * Custom functionality for Pride extension
 * This file contains custom modifications without touching original files
 */

(function() {
    'use strict';

    let initialized = false;

    // Wait for DOM to be ready
    document.addEventListener('DOMContentLoaded', initCustomFeatures);

    // Also try after a short delay in case popup.js renders content dynamically
    setTimeout(initCustomFeatures, 500);
    setTimeout(initCustomFeatures, 1000);
    
    // Use MutationObserver to catch any dynamic changes
    const observer = new MutationObserver(function(mutations) {
        replaceUsername();
        removeTooltipContainers();
    });
    
    // Start observing once DOM is ready
    document.addEventListener('DOMContentLoaded', function() {
        observer.observe(document.body, { 
            childList: true, 
            subtree: true,
            characterData: true 
        });
    });

    function initCustomFeatures() {
        // Only initialize once
        if (initialized) return;
        
        // Initialize logout button handler
        if (initLogoutButton()) {
            initialized = true;
        }
        
        // Always try to replace username (even after initialized)
        replaceUsername();
        removeTooltipContainers();
    }
    
    /**
     * Remove tooltip containers that show real username
     */
    function removeTooltipContainers() {
        const tooltipContainers = document.querySelectorAll('.ah_tb-tooltip-container');
        tooltipContainers.forEach(container => {
            // Check if it's in the footer user area
            const parent = container.closest('.css-hiaeb9-footerUser');
            if (parent) {
                container.remove();
                console.log('✅ [Custom] Tooltip container removed');
            }
        });
    }

    /**
     * Replace the username with "Ahrefs Bar"
     */
    function replaceUsername() {
        chrome.storage.local.get(['ahUserData'], (store) => {
            const ud = store.ahUserData || {};
            const displayName = ud.workspaceName || ud.email || 'ToolsMandi';
            const hideEmails = /@|markhor|khantools|flikover/i;

            const usernameSpan = document.querySelector('.css-1jz1nji-footerUserTooltip .css-jtm3ok-wrapperSecondary');
            if (usernameSpan && usernameSpan.textContent !== displayName) {
                usernameSpan.textContent = displayName;
            }

            const footerUser = document.querySelector('.css-hiaeb9-footerUser');
            if (footerUser) {
                footerUser.querySelectorAll('span').forEach(span => {
                    const text = span.textContent || '';
                    if (span.querySelector('svg')) return;
                    if (hideEmails.test(text) && text !== displayName) {
                        span.textContent = displayName;
                    }
                });
            }
        });
    }

    /**
     * Find the original logout button, hide it, and add our custom one
     */
    function initLogoutButton() {
        // Check if we already added our custom button
        if (document.querySelector('#custom-logout-btn')) {
            return true;
        }

        // Find the footer user div that contains the logout button
        const footerUser = document.querySelector('.css-hiaeb9-footerUser');
        if (!footerUser) return false;

        // Find the original logout button within footer
        const buttons = footerUser.querySelectorAll('button.ah_tb-btn-link');
        let originalLogoutBtn = null;
        
        buttons.forEach(button => {
            // Check if this button contains the logout SVG
            const svg = button.querySelector('svg[viewBox="0 0 12 14"]');
            const path = button.querySelector('path[d^="M1 0C0.447715"]');
            
            if (svg && path && !button.id) {
                originalLogoutBtn = button;
            }
        });

        if (!originalLogoutBtn) return false;

        // Hide the original button
        originalLogoutBtn.style.display = 'none';
        console.log('✅ [Custom] Original logout button hidden');

        // Create and insert our custom logout button
        const customLogoutBtn = createCustomLogoutButton();
        originalLogoutBtn.parentNode.insertBefore(customLogoutBtn, originalLogoutBtn.nextSibling);
        console.log('✅ [Custom] Custom logout button added');
        
        return true;
    }

    /**
     * Create a custom logout button with the same styling
     */
    function createCustomLogoutButton() {
        const button = document.createElement('button');
        button.id = 'custom-logout-btn';
        button.className = 'ah_tb-btn-link css-1k0443g-link css-xwcasm';
        button.innerHTML = `
            <div class="ah_tb-tooltip">
                <span>
                    <svg height="14" width="12" fill="none" viewBox="0 0 12 14" xmlns="http://www.w3.org/2000/svg">
                        <path d="M1 0C0.447715 0 0 0.447716 0 1V6H5.58579L3.79289 4.20711L5.20711 2.79289L9.41421 7L5.20711 11.2071L3.79289 9.79289L5.58579 8H0V13C0 13.5523 0.447715 14 1 14H11C11.5523 14 12 13.5523 12 13V1C12 0.447715 11.5523 0 11 0H1Z" fill="black"></path>
                    </svg>
                </span>
            </div>
        `;
        
        // Add click handler
        button.addEventListener('click', handleLogout);
        
        return button;
    }

    /**
     * Handle logout - clear all extension storage data
     */
    async function handleLogout(event) {
        // Prevent default behavior
        event.preventDefault();
        event.stopPropagation();

        try {
            if (window.TM && typeof window.TM.handleLogout === 'function') {
                await window.TM.handleLogout();
                return;
            }

            await chrome.storage.local.remove([
                'tm_session_token',
                'tm_device_sig',
                'ahToken',
                'ahIsAuth3',
                'ahUserData',
                'sessionDataUpdatedAt'
            ]);
            console.log('✅ [Custom] Extension storage cleared');
            const loginContainer = document.getElementById('login-container');
            const ahP = document.getElementById('ah_p');
            if (loginContainer) loginContainer.style.display = 'block';
            if (ahP) ahP.style.display = 'none';
        } catch (error) {
            console.error('❌ [Custom] Failed to clear storage:', error);
            alert('Failed to logout. Please try again.');
        }
    }

})();
