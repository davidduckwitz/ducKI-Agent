// Smooth Scroll für Nav-Links
document.querySelectorAll('a[href^="#"]').forEach(function (link) {
  link.addEventListener('click', function (e) {
    const target = document.querySelector(this.getAttribute('href'));
    if (target) {
      e.preventDefault();
      target.scrollIntoView({ behavior: 'smooth' });
    }
  });
});

// Einfache Reveal-Animation für Cards
const cards = document.querySelectorAll('.card');
const obs = new IntersectionObserver(function (entries) {
  entries.forEach(function (entry) {
    if (entry.isIntersecting) entry.target.style.opacity = 1;
  });
}, { threshold: 0.1 });

cards.forEach(function (c) {
  c.style.opacity = 0;
  c.style.transition = 'opacity .5s ease';
  obs.observe(c);
});
