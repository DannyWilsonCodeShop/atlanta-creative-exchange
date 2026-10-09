/**
 * Atlanta Creative Exchange — Quote Modal Controller
 * Handles: modal open/close, multi-step navigation, form validation,
 * submission to API Gateway, popup trigger after delay.
 */

(function () {
    'use strict';

    // === CONFIG ===
    // This will be replaced after deploying the backend
    const API_ENDPOINT = 'https://zuq0ae5dqf.execute-api.us-east-1.amazonaws.com';

    // === DOM REFS ===
    const overlay = document.getElementById('quoteOverlay');
    const modal = document.getElementById('quoteModal');
    const closeBtn = document.getElementById('quoteClose');
    const form = document.getElementById('quoteForm');
    const successEl = document.getElementById('quoteSuccess');
    const errorEl = document.getElementById('quoteError');
    const successCloseBtn = document.getElementById('quoteSuccessClose');
    const progressSteps = document.querySelectorAll('.progress-step');

    let currentStep = 'd1';
    const stepHistory = [];

    // === MODAL OPEN/CLOSE ===
    function openModal() {
        overlay.classList.add('active');
        modal.classList.add('active');
        document.body.style.overflow = 'hidden';
        // Dismiss popup if visible
        const popup = document.getElementById('quotePopup');
        if (popup) popup.classList.remove('visible');
    }

    function closeModal() {
        overlay.classList.remove('active');
        modal.classList.remove('active');
        document.body.style.overflow = '';
    }

    closeBtn.addEventListener('click', closeModal);
    overlay.addEventListener('click', closeModal);
    if (successCloseBtn) {
        successCloseBtn.addEventListener('click', closeModal);
    }

    // Close on Escape
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal.classList.contains('active')) {
            closeModal();
        }
    });

    // Expose globally so buttons can trigger it
    window.openQuoteModal = openModal;

    // === MULTI-STEP NAVIGATION ===
    function showStep(stepNum) {
        document.querySelectorAll('.quote-step').forEach(s => s.classList.remove('active'));

        // Step ids are always digital (d1/d2/d3)
        const stepId = 'stepD' + stepNum.charAt(1);
        const target = document.getElementById(stepId);
        if (target) target.classList.add('active');

        // Update progress indicators
        const progressSteps = document.querySelectorAll('#digitalProgress .progress-step');
        const stepIndex = parseInt(stepNum.charAt(1));

        progressSteps.forEach(ps => {
            const sIndex = parseInt(ps.dataset.step.charAt(1));
            ps.classList.remove('active', 'completed');
            if (sIndex === stepIndex) ps.classList.add('active');
            else if (sIndex < stepIndex) ps.classList.add('completed');
        });

        currentStep = stepNum;
        modal.scrollTop = 0;
    }

    function validateStep(stepId) {
        const stepElId = 'stepD' + stepId.charAt(1);
        const step = document.getElementById(stepElId);
        if (!step) return true;

        const required = step.querySelectorAll('[required]');
        let valid = true;

        required.forEach(field => {
            if (!field.value || !field.value.trim()) {
                field.style.borderColor = 'var(--color-magenta)';
                valid = false;
            } else {
                field.style.borderColor = '';
            }
        });

        // Digital step d1: check at least one digital service
        if (stepId === 'd1') {
            const checked = step.querySelectorAll('input[name="digitalServices"]:checked');
            if (checked.length === 0) {
                valid = false;
                const grp = step.querySelector('.checkbox-group');
                if (grp) grp.style.outline = '1px solid var(--color-magenta)';
            } else {
                const grp = step.querySelector('.checkbox-group');
                if (grp) grp.style.outline = '';
            }
        }

        return valid;
    }

    // Next buttons
    document.querySelectorAll('.step-next').forEach(btn => {
        btn.addEventListener('click', () => {
            const next = btn.dataset.next;
            if (validateStep(currentStep)) {
                stepHistory.push(currentStep);
                showStep(next);
            }
        });
    });

    // Prev buttons — use history stack instead of hardcoded destinations
    document.querySelectorAll('.step-prev').forEach(btn => {
        btn.addEventListener('click', () => {
            if (stepHistory.length > 0) {
                const prev = stepHistory.pop();
                showStep(prev);
            }
        });
    });

    // === FORM SUBMISSION ===
    form.addEventListener('submit', async function (e) {
        e.preventDefault();

        if (!validateStep('d3')) return;

        const formData = {
                serviceType: 'digital',
                digitalServices: Array.from(form.querySelectorAll('[name="digitalServices"]:checked')).map(c => c.value),
                platform: form.querySelector('[name="platform"]')?.value || '',
                projectDescription: form.querySelector('[name="projectDescription"]').value,
                hasExisting: form.querySelector('[name="hasExisting"]').value || '',
                existingUrl: form.querySelector('[name="existingUrl"]').value || '',
                pageCount: form.querySelector('[name="pageCount"]').value || '',
                timeline: form.querySelector('[name="timeline"]').value || '',
                features: Array.from(form.querySelectorAll('[name="features"]:checked')).map(c => c.value),
                designDirection: form.querySelector('[name="designDirection"]').value || '',
                referenceSites: form.querySelector('[name="referenceSites"]').value || '',
                digitalBudget: form.querySelector('[name="digitalBudget"]').value || '',
                ongoingSupport: form.querySelector('[name="ongoingSupport"]').value || '',
                digitalNotes: form.querySelector('[name="digitalNotes"]').value || '',
                firstName: form.querySelector('[name="dFirstName"]').value,
                lastName: form.querySelector('[name="dLastName"]').value,
                email: form.querySelector('[name="dEmail"]').value,
                phone: form.querySelector('[name="dPhone"]').value,
                organization: form.querySelector('[name="dOrganization"]').value || '',
                howHeard: form.querySelector('[name="dHowHeard"]').value || '',
                submittedAt: new Date().toISOString(),
                source: window.location.pathname,
                honeypot: form.querySelector('[name="honeypot"]')?.value || '',
        };

        // Show loading state
        const activeSubmitBtn = document.getElementById('digitalSubmit');
        activeSubmitBtn.classList.add('btn-loading');
        activeSubmitBtn.textContent = 'Submitting...';
        errorEl.style.display = 'none';

        try {
            const response = await fetch(API_ENDPOINT + '/quote', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(formData)
            });

            if (!response.ok) throw new Error('Server error');

            const result = await response.json();
            if (result.error) throw new Error(result.error);

            // Show success
            document.querySelectorAll('.quote-step').forEach(s => s.classList.remove('active'));
            document.querySelectorAll('.quote-progress').forEach(p => p.style.display = 'none');
            document.querySelector('.quote-header').style.display = 'none';
            successEl.style.display = 'block';

        } catch (err) {
            console.error('Quote submission error:', err);
            errorEl.style.display = 'block';
        } finally {
            const activeBtn = document.querySelector('.btn-loading');
            if (activeBtn) {
                activeBtn.classList.remove('btn-loading');
                activeBtn.textContent = 'Request my free demo';
            }
        }
    });

    // === FLOATING ACTION BUTTON ===
    const fab = document.createElement('button');
    fab.className = 'quote-fab';
    fab.id = 'quoteFab';
    fab.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
        Free Demo
    `;
    fab.addEventListener('click', () => {
        openModal();
    });
    document.body.appendChild(fab);

    // === POPUP AFTER DELAY ===
    const popup = document.createElement('div');
    popup.className = 'quote-popup';
    popup.id = 'quotePopup';
    popup.innerHTML = `
        <button class="quote-popup-close" aria-label="Dismiss">&times;</button>
        <h4>Got an app idea?</h4>
        <p>See it first with a free demo of your web or mobile app build — no obligation. Our team responds within 24 hours.</p>
        <button class="btn btn-primary" onclick="openQuoteModal()">Request a free demo</button>
    `;
    document.body.appendChild(popup);

    // Dismiss popup
    popup.querySelector('.quote-popup-close').addEventListener('click', () => {
        popup.classList.remove('visible');
        sessionStorage.setItem('ace_popup_dismissed', '1');
    });

    // Show popup after 15 seconds (only once per session)
    if (!sessionStorage.getItem('ace_popup_dismissed')) {
        setTimeout(() => {
            if (!modal.classList.contains('active')) {
                popup.classList.add('visible');
            }
        }, 15000);
    }

    // === INLINE QUOTE BUTTONS ===
    // Any element with data-quote-trigger opens the modal on step D1
    document.querySelectorAll('[data-quote-trigger]').forEach(el => {
        el.addEventListener('click', (e) => {
            e.preventDefault();
            openModal();
        });
    });

})();
