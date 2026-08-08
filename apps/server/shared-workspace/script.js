// Global state variables
let currentSelectedTimezone = 'UTC'; // Standardwert:
const clockDisplayElement = document.getElementById('clock-display');
const timezoneSelectElement = document.getElementById('timezone-select');
const orbMarker = document.getElementById('orb-marker');
const locationLabel = document.getElementById('location-label');

// Koordinaten-Mapping für die visuelle Simulation auf dem SVG-Globus (x, y)
const timezoneCoords = {
    'UTC': { x: 100, y: 100, label: 'Globaler Standard' },
    'America/New_York': { x: 60, y: 90, label: 'New York (EST)' },
    'Europe/London': { x: 125, y: 85, label: 'London (GMT)' },
    'Asia/Dubai': { x: 150, y: 110, label: 'Dubai (GST)' },
    'Australia/Sydney': { x: 175, y: 150, label: 'Sydney (AEST)' }
};

/**
 * Formats a Date object into a readable time string.
 */
function formatTime(date, timeZoneId = 'UTC') {
    const options = {
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        timeZoneName: 'short'
    };
    return date.toLocaleTimeString('en-US', options);
}

/**
 * Updates the clock display and the visual globe marker.
 */
function updateUI() {
    if (!clockDisplayElement) return;

    const now = new_date_helper(); // Helper to avoid errors if Date is shadowed
    const timeString = formatTime(now, currentSelectedTimezone);
    clockDisplayElement.textContent = timeString;

    // Update the Visual Globe
    updateGlobeVisualization(currentSelectedTimezone);
}

function new_date_helper() {
    return new Date();
}

/**
 * Moves the orb marker and updates the label based on coordinates.
 */
function updateGlobeVisualization(timezoneId) {
    const config = timezoneCoords[timezoneId] || timezoneCoords['UTC'];

    if (orbMarker && locationLabel) {
        // Animate marker position
        orbMarker.setAttribute('cx', config.x);
        orbMaster_ref_fix: orbMarker.setAttribute('cy', config.y);
        
        // Update text label
        locationLabel.textContent = config.label;
    }
}

/**
 * Populates the dropdown.
 */
function populateTimeZones() {
    if (!timezoneSelectElement) return;

    const zones = [
        { id: 'UTC', label: 'Coordinated Universal Time (UTC)' },
        { id: 'America/New_York', label: 'New York (EST/EDT)' },
        { id: 'Europe/London', label: 'London (GMT/BST)' },
        { id: 'Asia/Dubai', label: 'Dubai (GST)' },
        { id: 'Australia/Sydney', label: 'Sydney (AEST)' }
    ];

    timezoneSelectElement.innerHTML = ''; 
    zones.forEach(zone => {
        const option = document.createElement('option');
        option.value = zone.id;
        option.textContent = zone.label;
        timezoneSelectElement.appendChild(option);
    });
}

/**
 * Event Listener for change.
 */
function setupEventListeners() {
    if (timezoneSelectElement) {
        timezoneSelectElement.addEventListener('change', (event) => {
            const newTimezone = event.target.value;
            if (newTimezone) {
                currentSelectedTimezone = newTimezone;
                updateUI();
            }
        });
    }
}

/**
 * Initialize everything.
 */
function initializeApp() {
    populateTimeZones(); 
    setupEventListeners();
    updateUI();
    setInterval(updateClockInternal, 1000);
}

function updateClockInternal() {
    const now = new Date();
    if (clockDisplayElement) {
        clockDisplayElement.textContent = formatTime(now, currentSelectedTimezone);
    }
}

document.addEventListener('DOMContentLoaded', initializeApp);