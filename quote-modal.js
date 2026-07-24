/**
 * Atlanta Creative Exchange — Quote Modal Controller
 * Handles: modal open/close, multi-step navigation, form validation,
 * submission to API Gateway, popup trigger after delay.
 */

(function () {
    'use strict';

    // === CONFIG ===
    // This will be replaced after deploying the backend
    const API_ENDPOINT = '%%API_ENDPOINT%%';

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

    // === MULTI-STEP NAVIGATION ===
    function showStep(stepNum) {
        document.querySelectorAll('.quote-step').forEach(s => s.classList.remove('active'));
        const target = document.getElementById('step' + stepNum);
        if (target) target.classList.add('active');

        // Update progress
        progressSteps.forEach(ps => {
            const sNum = parseInt(ps.dataset.step);
            ps.classList.remove('active', 'completed');
            if (sNum === stepNum) ps.classList.add('active');
            else if (sNum < stepNum) ps.classList.add('completed');
        });

        currentStep = stepNum;
        // Scroll modal to top
        modal.scrollTop = 0;
    }

    function validateStep(stepNum) {
        const step = document.getElementById('step' + stepNum);
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

        // Step 1: check at least one service selected
        if (stepNum === 1) {
            const checked = step.querySelectorAll('input[name="services"]:checked');
            if (checked.length === 0) {
                valid = false;
                // Highlight the checkbox group
                const grp = step.querySelector('.checkbox-group');
                if (grp) grp.style.outline = '1px solid var(--color-magenta)';
            } else {
                const grp = step.querySelector('.checkbox-group');
                if (grp) grp.style.outline = '';
            }
        }

        // Step 2: check room size radio
        if (stepNum === 2) {
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

        return valid;
    }

    // Next buttons
    document.querySelectorAll('.step-next').forEach(btn => {
        btn.addEventListener('click', () => {
            const nextStep = parseInt(btn.dataset.next);
            if (validateStep(currentStep)) {
                showStep(nextStep);
            }
        });
    });

    // Prev buttons
    document.querySelectorAll('.step-prev').forEach(btn => {
        btn.addEventListener('click', () => {
            const prevStep = parseInt(btn.dataset.prev);
            showStep(prevStep);
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

        if (!validateStep(4)) return;

        // Gather all form data
        const formData = {
            // Event
            eventType: form.querySelector('[name="eventType"]').value,
            eventDate: form.querySelector('[name="eventDate"]').value,
            startTime: form.querySelector('[name="startTime"]').value,
            endTime: form.querySelector('[name="endTime"]').value,
            services: Array.from(form.querySelectorAll('[name="services"]:checked')).map(c => c.value),
            genre: form.querySelector('[name="genre"]').value || '',
            speeches: form.querySelector('[name="speeches"]').value,
            budget: form.querySelector('[name="budget"]').value,
            // Venue
            venueName: form.querySelector('[name="venueName"]').value,
            venueAddress: form.querySelector('[name="venueAddress"]').value,
            roomName: form.querySelector('[name="roomName"]').value || '',
            floorAccess: form.querySelector('[name="floorAccess"]').value,
            indoorOutdoor: form.querySelector('[name="indoorOutdoor"]').value,
            roomSize: form.querySelector('[name="roomSize"]:checked').value,
            powerAvailability: form.querySelector('[name="powerAvailability"]').value,
            loadInTime: form.querySelector('[name="loadInTime"]').value || '',
            // Equipment
            micWireless: form.querySelector('[name="micWireless"]').value,
            micWired: form.querySelector('[name="micWired"]').value,
            auxInputs: form.querySelector('[name="auxInputs"]').value || '',
            monitorSpeakers: form.querySelector('[name="monitorSpeakers"]').value,
            additionalNotes: form.querySelector('[name="additionalNotes"]').value || '',
            // Contact
            firstName: form.querySelector('[name="firstName"]').value,
            lastName: form.querySelector('[name="lastName"]').value,
            email: form.querySelector('[name="email"]').value,
            phone: form.querySelector('[name="phone"]').value,
            organization: form.querySelector('[name="organization"]').value || '',
            howHeard: form.querySelector('[name="howHeard"]').value,
            // Meta
            submittedAt: new Date().toISOString(),
            source: window.location.pathname
        };

        // Show loading state
        submitBtn.classList.add('btn-loading');
        submitBtn.textContent = 'Submitting...';
        errorEl.style.display = 'none';

        try {
            const response = await fetch(API_ENDPOINT + '/quote', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(formData)
            });

            if (!response.ok) throw new Error('Server error');

            // Show success
            document.querySelectorAll('.quote-step').forEach(s => s.classList.remove('active'));
            document.querySelector('.quote-progress').style.display = 'none';
            document.querySelector('.quote-header').style.display = 'none';
            successEl.style.display = 'block';

        } catch (err) {
            console.error('Quote submission error:', err);
            errorEl.style.display = 'block';
        } finally {
            submitBtn.classList.remove('btn-loading');
            submitBtn.textContent = 'Submit Quote Request';
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
