(function() {
  const timeDisplay = document.getElementById('time');
  const dayDisplay = document.getElementById('day');
  const dateDisplay = document.getElementById('date');

  function tick() {
    const now = new Date();
    
    // Uhrzeit formatiere

    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    timeDisplay.textContent = `${h}:${m}:${s}`;
    
    // Tag und Datum formatieren (Deutsch)
    const formatter = new Intl.DateTimeFormat('de-DE', {
      weekday: 'long',
      day: '2-digit',
      month: 'long',
      year: 'numeric'
    });
    
    const formatted = formatter.format(now);
    const parts = formatted.split(', ');
    
    dayDisplay.textContent = parts[0];  // z.B. "Freitag"
    dateDisplay.textContent = parts.slice(1).join(', ');  // z.B. "31. Juli 2026"
  }
  
  tick();
  setInterval(tick, 1000);
})();