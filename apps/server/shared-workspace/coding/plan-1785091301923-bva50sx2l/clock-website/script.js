function updateClock() {
    const now = new Date();

    // Zeit formatieren
    const timeString = now.toLocaleTimeString('de-DE');
    document.getElementById('clock').textContent = timeString;

    // Datum formatieren
    const dateString = now.toLocaleDateString('de-DE', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });
    document.getElementById('date').textContent = dateString;

    // Wochentag formatieren
    const dayString = now.toLocaleDateString('de-DE', {
        weekday: 'long'
    });
    document.getElementById('day').textContent = dayString;
}

// Alle 1000ms (1 Sekunde) aktualisieren
setInterval(updateClock, 1000);

// Initiales Aufrufen
updateClock();