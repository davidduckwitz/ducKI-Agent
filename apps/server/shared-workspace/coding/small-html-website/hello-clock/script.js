const clockElement = document.getElementById('clock');

function updateClock() {
    const now = new Date();
    
    const dayNames = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
    const monthNames = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
    
    const day = dayNames[now.getDay()];
    const date = now.getDate();
    const month = monthNames[now.getMonth()];
    const year = now.getFullYear();
    
    // Format: heute ist Freitag der 13. Oktober 2134
    // Adding ordinal indicator for day (simplified: . for all except 11, 12, 13, but let's keep it simple as per example)
    clockElement.textContent = `heute ist ${day} der ${date}. ${month} ${year}`;
}

setInterval(updateClock, 1000);
updateClock();