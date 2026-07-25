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

    // === MULTI-DATE EVENT HANDLING ===
    let eventDateCount = 1;
    const eventDatesContainer = document.getElementById('eventDatesContainer');
    const addEventDateBtn = document.getElementById('addEventDate');
    const sameServicesGroup = document.getElementById('sameServicesGroup');
    const sameServicesCheck = document.getElementById('sameServicesCheck');
    const step1NextBtn = document.getElementById('step1Next');

    if (addEventDateBtn) {
        addEventDateBtn.addEventListener('click', () => {
            eventDateCount++;
            const block = document.createElement('div');
            block.className = 'event-date-block';
            block.dataset.index = eventDateCount - 1;
            block.innerHTML = `
                <div class="event-date-header">
                    <span class="event-date-num">Day ${eventDateCount}</span>
                    <button type="button" class="btn-remove-date" onclick="this.closest('.event-date-block').remove(); updateDateNumbers();">Remove</button>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label>Date *</label>
                        <input type="date" name="eventDates[${eventDateCount - 1}].date" required onclick="this.showPicker()">
                    </div>
                    <div class="form-group">
                        <label>Start Time *</label>
                        <input type="time" name="eventDates[${eventDateCount - 1}].startTime" required onclick="this.showPicker()">
                    </div>
                    <div class="form-group">
                        <label>End Time *</label>
                        <input type="time" name="eventDates[${eventDateCount - 1}].endTime" required onclick="this.showPicker()">
                    </div>
                </div>
            `;
            eventDatesContainer.appendChild(block);
            sameServicesGroup.style.display = 'block';
            updateStep1NextTarget();
        });
    }

    // Update day numbers after removal
    window.updateDateNumbers = function() {
        const blocks = eventDatesContainer.querySelectorAll('.event-date-block');
        eventDateCount = blocks.length;
        blocks.forEach((block, i) => {
            block.querySelector('.event-date-num').textContent = `Day ${i + 1}`;
        });
        if (eventDateCount <= 1) {
            sameServicesGroup.style.display = 'none';
        }
        updateStep1NextTarget();
    };

    // Update step 1 next button target based on same-services checkbox
    function updateStep1NextTarget() {
        const servicesGroup = document.getElementById('servicesGroup');
        const genreGroup = document.getElementById('genreGroup');
        const sameLocation = document.getElementById('sameLocationCheck');
        const needsPerDay = eventDateCount > 1 && sameServicesCheck && (!sameServicesCheck.checked || (sameLocation && !sameLocation.checked));

        if (needsPerDay) {
            step1NextBtn.dataset.next = '1b';
            step1NextBtn.textContent = 'Next: Per-Day Details';
            // Hide services on step 1 if different services per day
            if (!sameServicesCheck.checked) {
                if (servicesGroup) servicesGroup.style.display = 'none';
                if (genreGroup) genreGroup.style.display = 'none';
            } else {
                if (servicesGroup) servicesGroup.style.display = 'block';
            }
        } else {
            step1NextBtn.dataset.next = '2';
            step1NextBtn.textContent = 'Next: Venue Details';
            if (servicesGroup) servicesGroup.style.display = 'block';
        }
    }

    if (sameServicesCheck) {
        sameServicesCheck.addEventListener('change', updateStep1NextTarget);
    }

    const sameLocationCheck = document.getElementById('sameLocationCheck');
    if (sameLocationCheck) {
        sameLocationCheck.addEventListener('change', updateStep1NextTarget);
    }

    // Generate per-day service cards when entering step 1b
    function buildPerDayCards() {
        const container = document.getElementById('perDayContainer');
        if (!container) return;
        container.innerHTML = '';
        const sameLocation = document.getElementById('sameLocationCheck')?.checked ?? true;
        const blocks = eventDatesContainer.querySelectorAll('.event-date-block');
        blocks.forEach((block, i) => {
            const dateInput = block.querySelector('input[type="date"]');
            const rawDate = dateInput ? dateInput.value : '';
            let dateDisplay = 'Date not set';
            if (rawDate) {
                const [y, m, d] = rawDate.split('-');
                const dt = new Date(y, m - 1, d);
                dateDisplay = dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            }

            let venueHtml = '';
            if (!sameLocation) {
                venueHtml = `
                    <div class="form-group">
                        <label>Venue Name *</label>
                        <input type="text" name="perDay[${i}].venueName" placeholder="Name of the venue" required>
                    </div>
                    <div class="form-group">
                        <label>Venue Address *</label>
                        <input type="text" name="perDay[${i}].venueAddress" placeholder="Full street address" required>
                    </div>
                    <div class="form-row">
                        <div class="form-group">
                            <label>Room / Space</label>
                            <input type="text" name="perDay[${i}].roomName" placeholder="e.g. Ballroom A">
                        </div>
                        <div class="form-group">
                            <label>Indoor / Outdoor</label>
                            <select name="perDay[${i}].indoorOutdoor">
                                <option value="Indoor">Indoor</option>
                                <option value="Outdoor">Outdoor</option>
                                <option value="Both">Both</option>
                            </select>
                        </div>
                    </div>
                    <div class="form-group">
                        <label>Venue Size</label>
                        <select name="perDay[${i}].roomSize">
                            <option value="">Select size</option>
                            <option value="Small">Small (up to 30 people)</option>
                            <option value="Small-Medium">Small-Medium (30–75 people)</option>
                            <option value="Medium">Medium (75–200 people)</option>
                            <option value="Medium-Large">Medium-Large (200–500 people)</option>
                            <option value="Large">Large (500+ people)</option>
                        </select>
                    </div>
                `;
            }
            const card = document.createElement('div');
            card.className = 'per-day-card';
            card.innerHTML = `
                <div class="per-day-header">
                    <strong>Day ${i + 1}</strong> — ${dateDisplay}
                </div>
                ${venueHtml}
                <div class="form-group">
                    <label>Services needed this day *</label>
                    <div class="checkbox-group">
                        <label class="checkbox-label"><input type="checkbox" name="perDay[${i}].services" value="DJ" onchange="updatePerDayQuestions(${i})"> DJ</label>
                        <label class="checkbox-label"><input type="checkbox" name="perDay[${i}].services" value="PA System" onchange="updatePerDayQuestions(${i})"> PA System</label>
                        <label class="checkbox-label"><input type="checkbox" name="perDay[${i}].services" value="Live Band" onchange="updatePerDayQuestions(${i})"> Live Band</label>
                        <label class="checkbox-label"><input type="checkbox" name="perDay[${i}].services" value="Event Hosting" onchange="updatePerDayQuestions(${i})"> Event Hosting</label>
                    </div>
                    <small class="form-note">Note: DJ includes basic PA. 1 wireless mic included for organizer announcements.</small>
                </div>
                <div id="perDayExtra-${i}"></div>
            `;
            container.appendChild(card);
        });

        // Update step 1b next button based on what's covered
        const step1bNextBtn = document.getElementById('step1bNext');
        const step2NextBtn = document.getElementById('step2Next');
        const sameLocationChk = document.getElementById('sameLocationCheck');
        const sameServicesChk = document.getElementById('sameServicesCheck');

        if (step1bNextBtn) {
            if (sameLocationChk && !sameLocationChk.checked) {
                // Venue covered per-day, services covered per-day → skip to contact
                if (sameServicesChk && !sameServicesChk.checked) {
                    step1bNextBtn.dataset.next = '4';
                    step1bNextBtn.textContent = 'Next: Contact Info';
                } else {
                    // Same services but different locations → still need step 3 for equipment
                    step1bNextBtn.dataset.next = '3';
                    step1bNextBtn.textContent = 'Next: Equipment Details';
                }
            } else {
                // Same location → need venue (step 2)
                if (sameServicesChk && !sameServicesChk.checked) {
                    // Different services per day → equipment covered, skip step 3 after venue
                    step1bNextBtn.dataset.next = '2';
                    step1bNextBtn.textContent = 'Next: Venue Details';
                    if (step2NextBtn) {
                        step2NextBtn.dataset.next = '4';
                        step2NextBtn.textContent = 'Next: Contact Info';
                    }
                } else {
                    step1bNextBtn.dataset.next = '2';
                    step1bNextBtn.textContent = 'Next: Venue Details';
                    if (step2NextBtn) {
                        step2NextBtn.dataset.next = '3';
                        step2NextBtn.textContent = 'Next: Equipment';
                    }
                }
            }
        }
    }

    // Dynamically show questions based on per-day service selections
    window.updatePerDayQuestions = function(dayIndex) {
        const card = document.querySelectorAll('.per-day-card')[dayIndex];
        if (!card) return;
        const selected = Array.from(card.querySelectorAll(`[name="perDay[${dayIndex}].services"]:checked`)).map(c => c.value);
        const extraDiv = document.getElementById(`perDayExtra-${dayIndex}`);
        if (!extraDiv) return;

        let html = '';

        // DJ or Live Band: genre + band type
        if (selected.includes('DJ') || selected.includes('Live Band')) {
            html += `
                <div class="form-group">
                    <label>Genre / Vibe</label>
                    <input type="text" name="perDay[${dayIndex}].genre" placeholder="e.g. R&B, Hip-Hop, Jazz, Top 40">
                </div>
            `;
            if (selected.includes('Live Band')) {
                html += `
                    <div class="form-group">
                        <label>Type of Live Music</label>
                        <select name="perDay[${dayIndex}].bandType">
                            <option value="">Select</option>
                            <option value="Instrumental">Instrumental (no vocals)</option>
                            <option value="Full Show">Full show (vocals + instruments)</option>
                            <option value="Acoustic">Acoustic / unplugged</option>
                            <option value="DJ + Live">DJ + live musicians together</option>
                        </select>
                    </div>
                `;
            }
        }

        // PA System only (no DJ/Band): full mic/equipment questions
        if (selected.includes('PA System') && !selected.includes('DJ') && !selected.includes('Live Band')) {
            html += `
                <div class="form-row">
                    <div class="form-group">
                        <label>Wireless Mics ($$)</label>
                        <select name="perDay[${dayIndex}].micWireless">
                            <option value="0">0</option><option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="4">4</option><option value="5+">5+</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label>Wired Mics ($)</label>
                        <select name="perDay[${dayIndex}].micWired">
                            <option value="0">0</option><option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="4">4</option><option value="5+">5+</option>
                        </select>
                    </div>
                </div>
                <div class="form-group">
                    <label>Aux / Instrument Inputs</label>
                    <input type="text" name="perDay[${dayIndex}].auxInputs" placeholder="e.g. 2 guitars, keyboard, laptop">
                </div>
            `;
        }

        // Notes for all
        html += `
            <div class="form-group">
                <label>Event flow & special instructions</label>
                <input type="text" name="perDay[${dayIndex}].notes" placeholder="e.g. Ceremony 5pm, cocktail hour 6pm, reception 7pm. Any special requests?">
            </div>
        `;

        extraDiv.innerHTML = html;
    };

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

        // Handle all step ID types
        let stepId;
        if (stepNum === 'serviceType') stepId = 'stepServiceType';
        else if (stepNum === '1b') stepId = 'step1b';
        else if (typeof stepNum === 'string' && stepNum.startsWith('d')) stepId = 'stepD' + stepNum.charAt(1);
        else stepId = 'step' + stepNum;

        const target = document.getElementById(stepId);
        if (target) target.classList.add('active');

        // Build per-day cards when entering step 1b
        if (stepNum === '1b') {
            buildPerDayCards();
        }

        // Show/hide equipment sections based on selected services
        if (stepNum === 3 || stepNum === '3') {
            const selectedServices = Array.from(form.querySelectorAll('[name="services"]:checked')).map(c => c.value);
            const hasPAOnly = selectedServices.includes('PA System') && !selectedServices.includes('DJ') && !selectedServices.includes('Live Band');
            const hasDJOrBand = selectedServices.includes('DJ') || selectedServices.includes('Live Band');
            const hostingOnly = selectedServices.includes('Event Hosting') && !hasDJOrBand && !selectedServices.includes('PA System');

            const paSection = document.getElementById('paEquipmentSection');
            const perfSection = document.getElementById('performanceSection');
            const hostSection = document.getElementById('hostingOnlySection');
            const bandTypeGroup = document.getElementById('bandTypeGroup');

            if (paSection) paSection.style.display = hasPAOnly ? 'block' : 'none';
            if (perfSection) perfSection.style.display = hasDJOrBand ? 'block' : 'none';
            if (hostSection) hostSection.style.display = hostingOnly ? 'block' : 'none';
            if (bandTypeGroup) bandTypeGroup.style.display = selectedServices.includes('Live Band') ? 'block' : 'none';

            // Monitors only for PA-only (no DJ/Band)
            const monitorsGroup = document.getElementById('monitorsGroup');
            if (monitorsGroup) monitorsGroup.style.display = hasPAOnly ? 'block' : 'none';

            // If both PA and DJ/Band selected, show PA section but hide monitors
            if (selectedServices.includes('PA System') && hasDJOrBand) {
                if (paSection) paSection.style.display = 'block';
                if (monitorsGroup) monitorsGroup.style.display = 'none';
            }
        }

        // Update progress indicators
        const isDigital = typeof stepNum === 'string' && stepNum.startsWith('d');
        const progressSteps = document.querySelectorAll(isDigital ? '#digitalProgress .progress-step' : '#eventProgress .progress-step');
        const stepIndex = isDigital ? parseInt(stepNum.charAt(1)) : (stepNum === '1b' ? 1 : parseInt(stepNum));

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

        // Step 1 (event): check at least one service selected (only if visible)
        if (stepId === 1) {
            const servicesGroup = document.getElementById('servicesGroup');
            if (servicesGroup && servicesGroup.style.display !== 'none') {
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
        }

        // Step 2 (event): check room size radio (only if step is visible/reached)
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

        // Step 4 (contact): check terms agreed
        if (stepId === 4) {
            const termsCheck = document.getElementById('q-terms');
            if (termsCheck && !termsCheck.checked) {
                valid = false;
                termsCheck.parentElement.style.color = 'var(--color-magenta)';
            } else if (termsCheck) {
                termsCheck.parentElement.style.color = '';
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
            const next = (nextStep.startsWith('d') || nextStep === '1b') ? nextStep : parseInt(nextStep);
            if (validateStep(currentStep)) {
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
                eventDates: Array.from(eventDatesContainer.querySelectorAll('.event-date-block')).map((block, i) => ({
                    date: block.querySelector(`[name="eventDates[${i}].date"]`)?.value || block.querySelector('input[type="date"]').value,
                    startTime: block.querySelector(`[name="eventDates[${i}].startTime"]`)?.value || block.querySelectorAll('input[type="time"]')[0].value,
                    endTime: block.querySelector(`[name="eventDates[${i}].endTime"]`)?.value || block.querySelectorAll('input[type="time"]')[1].value
                })),
                sameServicesAllDates: sameServicesCheck ? sameServicesCheck.checked : true,
                services: Array.from(form.querySelectorAll('[name="services"]:checked')).map(c => c.value),
                perDayDetails: (sameServicesCheck && !sameServicesCheck.checked && eventDateCount > 1) 
                    ? Array.from(document.querySelectorAll('.per-day-card')).map((card, i) => ({
                        services: Array.from(card.querySelectorAll(`[name="perDay[${i}].services"]:checked`)).map(c => c.value),
                        micWireless: card.querySelector(`[name="perDay[${i}].micWireless"]`)?.value || '0',
                        micWired: card.querySelector(`[name="perDay[${i}].micWired"]`)?.value || '0',
                        auxInputs: card.querySelector(`[name="perDay[${i}].auxInputs"]`)?.value || '',
                        notes: card.querySelector(`[name="perDay[${i}].notes"]`)?.value || ''
                    }))
                    : null,
                genre: form.querySelector('[name="genre"]')?.value || form.querySelector('[name="genre2"]')?.value || '',
                bandType: form.querySelector('[name="bandType"]')?.value || '',
                speeches: form.querySelector('[name="speeches"]')?.value || '',
                budget: form.querySelector('[name="budget"]')?.value || '',
                venueName: form.querySelector('[name="venueName"]')?.value || '',
                venueAddress: form.querySelector('[name="venueAddress"]')?.value || '',
                roomName: form.querySelector('[name="roomName"]')?.value || '',
                floorAccess: form.querySelector('[name="floorAccess"]')?.value || '',
                indoorOutdoor: form.querySelector('[name="indoorOutdoor"]')?.value || '',
                roomSize: form.querySelector('[name="roomSize"]:checked')?.value || '',
                powerAvailability: form.querySelector('[name="powerAvailability"]')?.value || '',
                loadInTime: form.querySelector('[name="loadInTime"]')?.value || '',
                micWireless: form.querySelector('[name="micWireless"]')?.value || '0',
                micWired: form.querySelector('[name="micWired"]')?.value || '0',
                auxInputs: form.querySelector('[name="auxInputs"]')?.value || '',
                monitorSpeakers: form.querySelector('[name="monitorSpeakers"]')?.value || '',
                additionalNotes: form.querySelector('[name="additionalNotes"]')?.value || '',
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
    fab.addEventListener('click', () => {
        openModal();
        // If on services-creative page, go straight to digital
        if (window.location.pathname.includes('services-creative')) {
            const digitalRadio = form.querySelector('input[name="serviceType"][value="digital"]');
            if (digitalRadio) digitalRadio.checked = true;
            document.getElementById('stepServiceType').classList.remove('active');
            document.getElementById('digitalProgress').style.display = 'flex';
            document.getElementById('eventProgress').style.display = 'none';
            document.getElementById('stepD1').classList.add('active');
            currentStep = 'd1';
            modal.scrollTop = 0;
        }
    });
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
    // If value is "digital", skip service type and go straight to digital path
    document.querySelectorAll('[data-quote-trigger]').forEach(el => {
        el.addEventListener('click', (e) => {
            e.preventDefault();
            openModal();

            const triggerType = el.getAttribute('data-quote-trigger');
            if (triggerType === 'digital') {
                // Pre-select digital and skip to first digital step
                const digitalRadio = form.querySelector('input[name="serviceType"][value="digital"]');
                if (digitalRadio) digitalRadio.checked = true;
                document.getElementById('stepServiceType').classList.remove('active');
                document.getElementById('digitalProgress').style.display = 'flex';
                document.getElementById('eventProgress').style.display = 'none';
                document.getElementById('stepD1').classList.add('active');
                currentStep = 'd1';
                modal.scrollTop = 0;
            }
        });
    });

})();
