/**
 * Retrofit Directory Client-side Application Logic
 */

document.addEventListener('DOMContentLoaded', () => {
    initMobileNav();
    initTextareaActions();
    initCookieConsent();
});

/**
 * Mobile Navigation Toggle
 */
function initMobileNav() {
    const toggleBtn = document.getElementById('mobileNavToggle');
    const navMenu = document.getElementById('navMenu');

    if (toggleBtn && navMenu) {
        toggleBtn.addEventListener('click', () => {
            navMenu.classList.toggle('open');
            const isOpen = navMenu.classList.contains('open');
            toggleBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        });
    }
}

/**
 * Textarea, Side Buttons (Copy/Save), 5 Action Buttons, and Backend Integration
 */
function initTextareaActions() {
    const textarea = document.getElementById('userTextarea');
    const btnCopy = document.getElementById('btnCopy');
    const btnSave = document.getElementById('btnSave');
    const outputPanel = document.getElementById('outputTextPanel');
    const statusBadge = document.getElementById('panelStatusBadge');

    if (!textarea) return;

    // Restore saved text if present in localStorage
    const savedContent = localStorage.getItem('retrofit_saved_text');
    if (savedContent && !textarea.value.trim()) {
        textarea.value = savedContent;
    }

    // Copy Button
    if (btnCopy) {
        btnCopy.addEventListener('click', () => {
            const text = textarea.value;
            if (!text) {
                showToast('Textarea is empty. Nothing to copy.');
                return;
            }
            navigator.clipboard.writeText(text).then(() => {
                showToast('Copied text to clipboard!');
            }).catch(err => {
                console.error('Failed to copy: ', err);
                showToast('Failed to copy to clipboard');
            });
        });
    }

    // Save Button
    if (btnSave) {
        btnSave.addEventListener('click', () => {
            const text = textarea.value;
            localStorage.setItem('retrofit_saved_text', text);
            showToast('Text saved locally!');
            sendToBackend(text, 'save');
        });
    }

    // Action Button 1: Analyze Retrofit Impact
    const btnAnalyze = document.getElementById('btnAnalyze');
    if (btnAnalyze) {
        btnAnalyze.addEventListener('click', () => {
            const text = textarea.value;
            sendToBackend(text, 'analyze');
        });
    }

    // Action Button 2: Extract Keywords
    const btnExtract = document.getElementById('btnExtract');
    if (btnExtract) {
        btnExtract.addEventListener('click', () => {
            const text = textarea.value;
            sendToBackend(text, 'extract_keywords');
        });
    }

    // Action Button 3: Format Submission
    const btnFormat = document.getElementById('btnFormat');
    if (btnFormat) {
        btnFormat.addEventListener('click', () => {
            let text = textarea.value;
            if (!text.trim()) {
                showToast('Please enter text to format.');
                return;
            }
            // Simple formatting clean up
            text = text.trim().replace(/\s+/g, ' ');
            textarea.value = text;
            showToast('Formatted text layout.');
            sendToBackend(text, 'format');
        });
    }

    // Action Button 4: Clear Form
    const btnClear = document.getElementById('btnClear');
    if (btnClear) {
        btnClear.addEventListener('click', () => {
            textarea.value = '';
            if (outputPanel) {
                outputPanel.textContent = 'Form cleared. Waiting for new input...';
            }
            if (statusBadge) {
                statusBadge.textContent = 'Idle';
                statusBadge.classList.remove('active');
            }
            showToast('Cleared text area.');
        });
    }

    // Action Button 5: Generate Summary
    const btnSummary = document.getElementById('btnSummary');
    if (btnSummary) {
        btnSummary.addEventListener('click', () => {
            const text = textarea.value;
            sendToBackend(text, 'summary');
        });
    }
}

/**
 * Backend API Stub Function
 * Simulates sending text data to backend service and returning dynamic response
 */
function sendToBackend(text, actionType = 'general') {
    const outputPanel = document.getElementById('outputTextPanel');
    const statusBadge = document.getElementById('panelStatusBadge');

    if (!outputPanel) return;

    // Set processing UI state
    if (statusBadge) {
        statusBadge.textContent = 'Processing...';
        statusBadge.classList.add('active');
    }
    outputPanel.textContent = 'Sending text payload to Retrofit Directory backend server...';

    // Simulated backend asynchronous API call delay
    setTimeout(() => {
        let responseContent = '';
        const textLength = text ? text.length : 0;
        const wordCount = text ? text.trim().split(/\s+/).filter(Boolean).length : 0;

        switch (actionType) {
            case 'save':
                responseContent = `[Backend Status: 200 OK]\nPayload successfully received and queued for directory indexing.\nCharacter count: ${textLength} | Word count: ${wordCount}\nTimestamp: ${new Date().toISOString()}`;
                break;

            case 'analyze':
                responseContent = `[Retrofit Impact Analysis Report]\n- Total Words: ${wordCount}\n- Estimated Scope: ${wordCount > 50 ? 'Comprehensive housing decarbonisation proposal' : 'Initial organisation profile query'}\n- Recommended Category: Housing Provider / Energy Policy / Retrofit Services\n- Status: Payload valid for directory taxonomy integration.`;
                break;

            case 'extract_keywords':
                const commonRetrofitTerms = ['retrofit', 'decarbonisation', 'insulation', 'heat pump', 'solar', 'housing', 'epc', 'emissions', 'policy', 'efficiency', 'energy', 'carbon'];
                const matched = commonRetrofitTerms.filter(term => text.toLowerCase().includes(term));
                responseContent = `[Extracted Directory Keywords]\nMatched Terms: ${matched.length > 0 ? matched.join(', ') : 'None detected (Try adding terms like retrofit, insulation, heat pump, energy, decarbonisation)'}\nTotal character count analyzed: ${textLength}`;
                break;

            case 'format':
                responseContent = `[Formatting Verification Response]\nCleaned text structure applied to input textarea.\nText length: ${textLength} characters. Ready for official directory submission.`;
                break;

            case 'summary':
                if (!text.trim()) {
                    responseContent = `[Executive Summary]\nNo text provided. Please enter text into the textarea above to generate a summary.`;
                } else {
                    const firstSentence = text.trim().split('.')[0] + '.';
                    responseContent = `[Executive Summary]\n"${firstSentence}"\n(Summary compiled from input of ${wordCount} words for UK Retrofit Directory records).`;
                }
                break;

            default:
                responseContent = `[Backend Response]\nText input successfully received. Server ready for directory database commit.\nLength: ${textLength} chars | Words: ${wordCount}`;
                break;
        }

        outputPanel.textContent = responseContent;

        if (statusBadge) {
            statusBadge.textContent = 'Response Received';
            statusBadge.classList.remove('active');
        }
    }, 600);
}

/**
 * Toast Notice System
 */
function showToast(message) {
    let toast = document.getElementById('toastNotice');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'toastNotice';
        toast.className = 'toast-notice';
        document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('show');

    setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
}

/**
 * Cookie Popup Consent Management
 */
function initCookieConsent() {
    const cookiePopup = document.getElementById('cookiePopup');
    const btnAccept = document.getElementById('acceptCookiesBtn');

    if (!cookiePopup || !btnAccept) return;

    const consentGiven = localStorage.getItem('retrofit_cookie_consent');
    if (!consentGiven) {
        // Show popup after slight delay
        setTimeout(() => {
            cookiePopup.classList.add('active');
        }, 800);
    }

    btnAccept.addEventListener('click', () => {
        localStorage.setItem('retrofit_cookie_consent', 'true');
        cookiePopup.classList.remove('active');
        showToast('Essential cookie policy accepted.');
    });
}
