document.addEventListener('DOMContentLoaded', () => {
  /* --- Mobile Menu Logic --- */
  const burger = document.querySelector('.burger');
  const overlay = document.querySelector('.mobile-overlay');
  const sheet = document.querySelector('.mobile-sheet');
  const mobileLinks = document.querySelectorAll('.mobile-link, .mobile-sign-in');

  function toggleMenu() {
    const isExpanded = burger.getAttribute('aria-expanded') === 'true';
    if (isExpanded) {
      closeMenu();
    } else {
      openMenu();
    }
  }

  function openMenu() {
    burger.setAttribute('aria-expanded', 'true');
    overlay.classList.remove('hidden');
    sheet.classList.remove('hidden');
    document.body.classList.add('menu-open');
  }

  function closeMenu() {
    burger.setAttribute('aria-expanded', 'false');
    overlay.classList.add('hidden');
    sheet.classList.add('hidden');
    document.body.classList.remove('menu-open');
  }

  if (burger) {
    burger.addEventListener('click', toggleMenu);
  }

  if (overlay) {
    overlay.addEventListener('click', closeMenu);
  }

  mobileLinks.forEach(link => {
    link.addEventListener('click', closeMenu);
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeMenu();
    }
  });

  window.addEventListener('resize', () => {
    if (window.innerWidth > 720) {
      closeMenu();
    }
  });


  /* --- Stats Count Up Logic --- */
  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
  
  const statsElements = document.querySelectorAll('.stat-value');
  let hasAnimated = false;

  function animateStats() {
    if (hasAnimated) return;
    
    // Check for reduced motion
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    statsElements.forEach((el, i) => {
      const target = parseFloat(el.getAttribute('data-target'));
      const suffix = el.getAttribute('data-suffix');
      const decimals = parseInt(el.getAttribute('data-decimals'), 10);
      
      if (prefersReducedMotion) {
        el.textContent = target.toFixed(decimals) + suffix;
        return;
      }

      const duration = 1500 + i * 80;
      const delay = 480 + i * 90;
      const startTime = performance.now() + delay;

      function update(currentTime) {
        const elapsed = currentTime - startTime;
        if (elapsed < 0) {
          requestAnimationFrame(update);
          return;
        }

        const progress = Math.min(elapsed / duration, 1);
        const easedProgress = easeOutCubic(progress);
        const currentValue = easedProgress * target;

        el.textContent = currentValue.toFixed(decimals) + suffix;

        if (progress < 1) {
          requestAnimationFrame(update);
        } else {
          el.textContent = target.toFixed(decimals) + suffix;
        }
      }

      requestAnimationFrame(update);
    });

    hasAnimated = true;
  }

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        animateStats();
        observer.disconnect();
      }
    });
  }, { threshold: 0.25 });

  const footer = document.querySelector('.stats-footer');
  if (footer) {
    observer.observe(footer);
  }
});
