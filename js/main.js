/* main.js — shared behavior for index.html + pages.html: reveal-on-scroll,
   scroll-scrub, pin-hold, progress bar, chevron field, mobile nav. */
(function () {
  "use strict";

  var body = document.body;
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function reveal() { body.classList.add("loaded"); }
  try {
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(reveal).catch(reveal);
    }
  } catch (e) {}
  setTimeout(reveal, 1600); // hard fallback: content must never stay hidden

  /* ---------- reveal-on-scroll: entrance only, plays once ---------- */
  try {
    var targets = document.querySelectorAll("[data-reveal]");
    if ("IntersectionObserver" in window) {
      var obs = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            obs.unobserve(entry.target);
          }
        });
        // threshold 0: with a clip-path initial state, higher thresholds can stick at ratio 0
      }, { threshold: 0 });
      targets.forEach(function (el) { obs.observe(el); });
    } else {
      targets.forEach(function (el) { el.classList.add("is-visible"); });
    }
  } catch (e) {}

  /* continuous scroll-scrub: runs every rAF frame so it stays smooth under momentum scrolling */
  var bumpFns = []; // velocity bus, used by the chevron field

  function clamp01(n) { return n < 0 ? 0 : n > 1 ? 1 : n; }

  // 0 = element entering viewport bottom, 1 = element left viewport top
  function spanProgress(el) {
    var r = el.getBoundingClientRect();
    var vh = window.innerHeight || 1;
    var total = r.height + vh;
    return clamp01((vh - r.top) / total);
  }

  // sticky-progress formula: 0 at pin start, 1 at pin end
  function pinProgress(wrapEl) {
    var r = wrapEl.getBoundingClientRect();
    var scrollable = r.height - (window.innerHeight || 1);
    if (scrollable <= 0) return 1;
    return clamp01(-r.top / scrollable);
  }

  var scrubEls = Array.prototype.slice.call(document.querySelectorAll("[data-scrub]"));

  var countEls = Array.prototype.slice.call(document.querySelectorAll("[data-count]")).map(function (el) {
    var value = parseFloat(el.getAttribute("data-value"));
    return { el: el, value: isNaN(value) ? 0 : value, isInt: Number.isInteger(value) };
  });
  var countSection = document.getElementById("stats");

  function formatCount(value, isInt) {
    return isInt ? String(Math.round(value)) : value.toFixed(1).replace(".", ",");
  }

  var aboutWrap = document.getElementById("about-pin-wrap");

  var contactWrap = document.getElementById("contact-pin-wrap");
  var contactLead = document.querySelector(".contact-lead");
  var contactData = document.querySelector(".contact-data");

  var heroEl = document.getElementById("hero");

  var lastY = window.scrollY;
  var bar = document.querySelector(".scroll-progress");

  function tick() {
    var scrollY = window.scrollY;
    var v = scrollY - lastY;
    lastY = scrollY;

    var max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    if (bar) bar.style.width = clamp01(scrollY / max) * 100 + "%";
    for (var b = 0; b < bumpFns.length; b++) bumpFns[b](v);

    // skip all scroll-linked motion under reduced-motion (static CSS fallback in base.css)
    if (!reduceMotion) {
      for (var i = 0; i < scrubEls.length; i++) {
        scrubEls[i].style.setProperty("--scrub", spanProgress(scrubEls[i]).toFixed(4));
      }

      if (heroEl) {
        var heroP = clamp01(-heroEl.getBoundingClientRect().top / (window.innerHeight || 1));
        heroEl.style.setProperty("--scrub", heroP.toFixed(4));
      }

      // --scrub cascades to .about-head/.about-body via CSS inheritance
      if (aboutWrap) {
        aboutWrap.style.setProperty("--scrub", pinProgress(aboutWrap).toFixed(4));
      }

      if (contactWrap && contactLead && contactData) {
        var p2 = pinProgress(contactWrap);
        var travel2 = Math.min(420, window.innerWidth * 0.3);
        var offset = (1 - p2) * travel2;
        contactLead.style.transform = "translateX(" + (-offset) + "px)";
        contactData.style.transform = "translateX(" + offset + "px)";
      }

      if (countSection && countEls.length) {
        var p3 = spanProgress(countSection) * 1.6; // finish a little before the section is gone
        for (var c = 0; c < countEls.length; c++) {
          var item = countEls[c];
          item.el.textContent = formatCount(item.value * clamp01(p3), item.isInt);
        }
      }
    }

    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  if (reduceMotion && countEls.length) {
    countEls.forEach(function (item) { item.el.textContent = formatCount(item.value, item.isInt); });
  }

  /* ---------- chevron field: the logo's own arrow shape, animated ---------- */
  function drawChevron(ctx, cx, cy, s, color, alpha) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.beginPath();
    ctx.moveTo(-0.5 * s, -0.6 * s);
    ctx.lineTo(0.1 * s, 0);
    ctx.lineTo(-0.5 * s, 0.6 * s);
    ctx.lineTo(-0.2 * s, 0.6 * s);
    ctx.lineTo(0.4 * s, 0);
    ctx.lineTo(-0.2 * s, -0.6 * s);
    ctx.closePath();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
  }

  function initChevronField(canvas, opts) {
    if (!canvas || !canvas.getContext) return;
    opts = opts || {};
    var density = opts.density || 48;
    var blueRatio = opts.blueRatio || 0.12;
    var ctx = canvas.getContext("2d");
    var w = 0, h = 0, dpr = 1, field = [];

    function buildField() {
      field = [];
      var cols = Math.max(4, Math.round(Math.sqrt(density * (w / Math.max(h, 1)))));
      var rows = Math.max(3, Math.round(density / cols));
      var cellW = w / cols, cellH = h / rows;
      for (var r = 0; r < rows; r++) {
        for (var c = 0; c < cols; c++) {
          field.push({
            y: r * cellH + cellH * 0.5 + (Math.random() - 0.5) * cellH * 0.5,
            size: cellH * (0.32 + Math.random() * 0.24),
            speed: 6 + Math.random() * 10,
            blue: Math.random() < blueRatio,
            phase: Math.random() * 1000
          });
        }
      }
    }
    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth; h = canvas.clientHeight;
      canvas.width = Math.max(1, Math.floor(w * dpr));
      canvas.height = Math.max(1, Math.floor(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      buildField();
    }
    window.addEventListener("resize", resize);
    resize();

    var energy = 1;
    function frame(t) {
      ctx.clearRect(0, 0, w, h);
      for (var i = 0; i < field.length; i++) {
        var f = field[i];
        var dx = ((t * 0.012 * energy * (f.speed / 10)) + f.phase * 2.7) % (w + f.size * 2) - f.size;
        drawChevron(ctx, dx, f.y, f.size, f.blue ? "#05a0f3" : "#3f3f3f", f.blue ? 0.18 : 0.07);
      }
      energy += (0.6 - energy) * 0.02;
      if (!reduceMotion) requestAnimationFrame(frame);
    }
    frame(0);
    if (!reduceMotion) {
      bumpFns.push(function (v) { energy = Math.min(2.2, energy + Math.abs(v) * 0.05); });
    }
  }

  /* ---------- pillar cards: pointer-tracked 3D tilt (hover-capable, non-touch only) ---------- */
  try {
    var canHover = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
    if (canHover && !reduceMotion) {
      document.querySelectorAll(".pillar-card").forEach(function (card) {
        card.style.transition = "transform .5s cubic-bezier(.16,1,.3,1)";
        card.addEventListener("pointermove", function (e) {
          var r = card.getBoundingClientRect();
          var px = (e.clientX - r.left) / r.width - 0.5;
          var py = (e.clientY - r.top) / r.height - 0.5;
          card.style.transition = "transform .08s linear";
          card.style.transform = "perspective(900px) rotateX(" + (py * -8) + "deg) rotateY(" + (px * 10) + "deg) translateZ(6px)";
        });
        card.addEventListener("pointerleave", function () {
          card.style.transition = "transform .5s cubic-bezier(.16,1,.3,1)";
          card.style.transform = "perspective(900px) rotateX(0) rotateY(0) translateZ(0)";
        });
      });
    }
  } catch (e) {}

  /* ---------- mobile nav: close menu after a link is tapped ---------- */
  try {
    var toggle = document.getElementById("nav-toggle");
    if (toggle) {
      document.querySelectorAll(".nav-links a").forEach(function (a) {
        a.addEventListener("click", function () { toggle.checked = false; });
      });
    }
  } catch (e) {}

  window.XDS = { initChevronField: initChevronField };
})();
