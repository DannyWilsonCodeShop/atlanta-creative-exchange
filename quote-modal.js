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
    const submitBtn = document.getElementById('quoteSubmit');
    const successEl = document.getElementById('quoteSuccess');
    const errorEl = document.getElementById('quoteError');
    const successCloseBtn = document.getElementById('quoteSuccessClose');
    const progressSteps = document.querySelectorAll('.progress-step');

    let currentStep = 1;

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

    // === SERVICE TYPE BRANCHING ===
    const serviceTypeNext = document.getElementById('serviceTypeNext');
    serviceTypeNext.addEventListener('click', () => {
        const selected = form.querySelector('input[name="serviceType"]:checked');
        if (!selected) {
            const cards = document.querySelector('.service-type-cards');
            cards.style.outline = '1px solid var(--color-magenta)';
            return;
        }
        document.querySelector('.service-type-cards').style.outline = '';
        document.getElementById('stepServiceType').classList.remove('active');

        if (selected.value === 'event') {
            document.getElementById('eventProgress').style.display = 'flex';
            document.getElementById('digitalProgress').style.display = 'none';
            document.getElementById('step1').classList.add('active');
            currentStep = 1;
        } else {
            document.getElementById('digitalProgress').style.display = 'flex';
            document.getElementById('eventProgress').style.display = 'none';
            document.getElementById('stepD1').classList.add('active');
            currentStep = 'd1';
        }
        modal.scrollTop = 0;
    });

    // === MULTI-STEP NAVIGATION ===
    function showStep(stepNum) {
        document.querySelectorAll('.quote-step').forEach(s => s.classList.remove('active'));

        // Handle digital path steps (d1, d2, d3) and service type
        const stepId = (typeof stepNum === 'string' && stepNum.startsWith('d'))
            ? 'stepD' + stepNum.charAt(1)
            : stepNum === 'serviceType' ? 'stepServiceType' : 'step' + stepNum;

        const target = document.getElementById(stepId);
        if (target) target.classList.add('active');

        // Update progress indicators
        const isDigital = typeof stepNum === 'string' && stepNum.startsWith('d');
        const progressSteps = document.querySelectorAll(isDigital ? '#digitalProgress .progress-step' : '#eventProgress .progress-step');
        const stepIndex = isDigital ? parseInt(stepNum.charAt(1)) : stepNum;

        progressSteps.forEach(ps => {
            const sNum = ps.dataset.step;
            const sIndex = isDigital ? parseInt(sNum.charAt(1)) : parseInt(sNum);
            ps.classList.remove('active', 'completed');
            if (sIndex === stepIndex) ps.classList.add('active');
            else if (sIndex < stepIndex) ps.classList.add('completed');
        });

        // Handle going back to service type
        if (stepNum === 'serviceType') {
            document.getElementById('eventProgress').style.display = 'none';
            document.getElementById('digitalProgress').style.display = 'none';
        }

        currentStep = stepNum;
        modal.scrollTop = 0;
    }

    function validateStep(stepId) {
        const stepElId = (typeof stepId === 'string' && stepId.startsWith('d'))
            ? 'stepD' + stepId.charAt(1)
            : 'step' + stepId;
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

        // Step 1 (event): check at least one service selected
        if (stepId === 1) {
            const checked = step.querySelectorAll('input[name="services"]:checked');
            if (checked.length === 0) {
                valid = false;
                const grp = step.querySelector('.checkbox-group');
                if (grp) grp.style.outline = '1px solid var(--color-magenta)';
            } else {
                const grp = step.querySelector('.checkbox-group');
                if (grp) grp.style.outline = '';
            }
        }

        // Step 2 (event): check room size radio
        if (stepId === 2) {
            const roomChecked = step.querySelector('input[name="roomSize"]:checked');
            if (!roomChecked) {
                valid = false;
                const cards = step.querySelector('.radio-cards');
                if (cards) cards.style.outline = '1px solid var(--color-magenta)';
            } else {
                const cards = step.querySelector('.radio-cards');
                if (cards) cards.style.outline = '';
            }
        }

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
            if (btn.id === 'serviceTypeNext') return; // handled separately
            const nextStep = btn.dataset.next;
            const next = nextStep.startsWith('d') ? nextStep : parseInt(nextStep);
            const curr = typeof currentStep === 'string' ? currentStep : currentStep;
            if (validateStep(curr)) {
                showStep(next);
            }
        });
    });

    // Prev buttons
    document.querySelectorAll('.step-prev').forEach(btn => {
        btn.addEventListener('click', () => {
            const prevStep = btn.dataset.prev;
            const prev = prevStep === 'serviceType' ? 'serviceType' : (prevStep.startsWith('d') ? prevStep : parseInt(prevStep));
            showStep(prev);
        });
    });

    // === CONDITIONAL FIELDS ===
    // Show genre field if DJ is selected
    const serviceCheckboxes = document.querySelectorAll('input[name="services"]');
    const genreGroup = document.getElementById('genreGroup');

    serviceCheckboxes.forEach(cb => {
        cb.addEventListener('change', () => {
            const djChecked = document.querySelector('input[name="services"][value="DJ"]').checked;
            genreGroup.style.display = djChecked ? 'block' : 'none';
        });
    });

    // === FORM SUBMISSION ===
    form.addEventListener('submit', async function (e) {
        e.preventDefault();

        const serviceType = form.querySelector('input[name="serviceType"]:checked').value;
        let formData;

        if (serviceType === 'event') {
            if (!validateStep(4)) return;
            formData = {
                serviceType: 'event',
                eventType: form.querySelector('[name="eventType"]').value,
                eventDate: form.querySelector('[name="eventDate"]').value,
                startTime: form.querySelector('[name="startTime"]').value,
                endTime: form.querySelector('[name="endTime"]').value,
                services: Array.from(form.querySelectorAll('[name="services"]:checked')).map(c => c.value),
                genre: form.querySelector('[name="genre"]').value || '',
                speeches: form.querySelector('[name="speeches"]').value,
                budget: form.querySelector('[name="budget"]').value,
                venueName: form.querySelector('[name="venueName"]').value,
                venueAddress: form.querySelector('[name="venueAddress"]').value,
                roomName: form.querySelector('[name="roomName"]').value || '',
                floorAccess: form.querySelector('[name="floorAccess"]').value,
                indoorOutdoor: form.querySelector('[name="indoorOutdoor"]').value,
                roomSize: form.querySelector('[name="roomSize"]:checked').value,
                powerAvailability: form.querySelector('[name="powerAvailability"]').value,
                loadInTime: form.querySelector('[name="loadInTime"]').value || '',
                micWireless: form.querySelector('[name="micWireless"]').value,
                micWired: form.querySelector('[name="micWired"]').value,
                auxInputs: form.querySelector('[name="auxInputs"]').value || '',
                monitorSpeakers: form.querySelector('[name="monitorSpeakers"]').value,
                additionalNotes: form.querySelector('[name="additionalNotes"]').value || '',
                firstName: form.querySelector('[name="firstName"]').value,
                lastName: form.querySelector('[name="lastName"]').value,
                email: form.querySelector('[name="email"]').value,
                phone: form.querySelector('[name="phone"]').value,
                organization: form.querySelector('[name="organization"]').value || '',
                howHeard: form.querySelector('[name="howHeard"]').value,
                submittedAt: new Date().toISOString(),
                source: window.location.pathname
            };
        } else {
            if (!validateStep('d3')) return;
            formData = {
                serviceType: 'digital',
                digitalServices: Array.from(form.querySelectorAll('[name="digitalServices"]:checked')).map(c => c.value),
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
                source: window.location.pathname
            };
        }

        // Show loading state
        const activeSubmitBtn = serviceType === 'event' ? submitBtn : document.getElementById('digitalSubmit');
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
                activeBtn.textContent = activeBtn.id === 'digitalSubmit' ? 'Submit Project Request' : 'Submit Quote Request';
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
        Get a Quote
    `;
    fab.addEventListener('click', openModal);
    document.body.appendChild(fab);

    // === POPUP AFTER DELAY ===
    const popup = document.createElement('div');
    popup.className = 'quote-popup';
    popup.id = 'quotePopup';
    popup.innerHTML = `
        <button class="quote-popup-close" aria-label="Dismiss">&times;</button>
        <h4>Planning an event?</h4>
        <p>Get a personalized quote for DJ, sound, live music, or hosting. Our team responds within 24 hours.</p>
        <button class="btn btn-primary" onclick="openQuoteModal()">Request a Quote</button>
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
    // Any element with data-quote-trigger opens the modal
    document.querySelectorAll('[data-quote-trigger]').forEach(el => {
        el.addEventListener('click', (e) => {
            e.preventDefault();
            openModal();
        });
    });

})();
