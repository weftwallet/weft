// The theme control's behaviour (header.css has its markup and styles).
// Plain script with no imports: ThemeControl.astro imports it, and the
// explorer inlines the file into its template. It runs once per page, after
// the markup, and serves every .weft-theme on the page (the docs have one
// in the header and one in the mobile menu) so they all show one choice.
//
// Three choices: system, light, dark. The choice is kept in localStorage
// under the key in data-weft-theme (the first group's). With no choice
// stored the page follows the system. data-always-set makes "system" write
// the system's theme to <html data-theme> rather than remove it (Starlight's
// styles need data-theme set). Changing the theme crossfades the page once,
// as a view transition; with reduced motion it changes at once.
//
// Semantics: a radio group with roving tabindex. Tab reaches the checked
// option only; Left/Up and Right/Down move the choice and apply it; Home and
// End go to the first and last.
(function () {
  var root = document.documentElement;
  var groups = Array.prototype.slice.call(document.querySelectorAll("[data-weft-theme]"));
  if (!groups.length) return;
  var key = groups[0].dataset.weftTheme || "weft-theme";
  var alwaysSet = groups.some(function (g) {
    return g.hasAttribute("data-always-set");
  });
  var system = matchMedia("(prefers-color-scheme: light)");
  var CHOICES = ["system", "light", "dark"];

  function stored() {
    try {
      var t = localStorage.getItem(key);
      return t === "light" || t === "dark" ? t : "system";
    } catch (e) {
      return "system";
    }
  }
  function options(group) {
    return Array.prototype.slice.call(group.querySelectorAll("[data-theme-choice]"));
  }
  // Every control shows the choice: aria-checked and the tab stop on the
  // chosen option, data-choice on the group for the thumb.
  function mark(choice) {
    groups.forEach(function (g) {
      g.dataset.choice = choice;
      options(g).forEach(function (b) {
        var on = b.dataset.themeChoice === choice;
        b.setAttribute("aria-checked", String(on));
        b.tabIndex = on ? 0 : -1;
      });
    });
  }
  function apply(choice) {
    if (choice !== "system") root.dataset.theme = choice;
    else if (alwaysSet) root.dataset.theme = system.matches ? "light" : "dark";
    else delete root.dataset.theme;
    mark(choice);
  }
  function choose(choice, focus) {
    try {
      if (choice === "system") localStorage.removeItem(key);
      else localStorage.setItem(key, choice);
    } catch (e) {}
    var still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (document.startViewTransition && !still) document.startViewTransition(function () { apply(choice); });
    else apply(choice);
    if (focus) {
      var b = focus.querySelector('[data-theme-choice="' + choice + '"]');
      if (b) b.focus();
    }
  }

  mark(stored());
  // The thumb may slide only after the stored choice is in place.
  requestAnimationFrame(function () {
    groups.forEach(function (g) { g.classList.add("is-ready"); });
  });
  if (alwaysSet) system.addEventListener("change", function () { if (stored() === "system") apply("system"); });

  groups.forEach(function (g) {
    options(g).forEach(function (b) {
      b.addEventListener("click", function () { choose(b.dataset.themeChoice); });
    });
    g.addEventListener("keydown", function (e) {
      var i = CHOICES.indexOf(stored());
      var next = -1;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % CHOICES.length;
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (i + CHOICES.length - 1) % CHOICES.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = CHOICES.length - 1;
      if (next < 0) return;
      e.preventDefault();
      choose(CHOICES[next], g);
    });
  });
})();
