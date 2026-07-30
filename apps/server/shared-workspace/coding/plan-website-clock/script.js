(function() {
  const clockDisplay = document.getElementById('clock');
  const dateDisplay = document.getElementById('date');

  function tick() {
    const now = new Date();
    
    // Uhrzeit formatiere

    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    clockDisplay.textContent = `${h}:${m}:${s}`;
    
    // Datum formatieren (Deutsch)
    const formatter = new Intl.DateTimeFormat('de-DE', {
      weekday: 'long',
      day: '2-digit',
      month: 'long',
      year: 'numeric'
    });
    dateDisplay.textContent = formatter.format(now);
  }
  
  tick();
  setInterval(tick, 1000);
})();