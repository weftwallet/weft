// The theme toggle's behaviour (header.css has its markup and styles).
// Plain script with no imports: Shell.astro and the docs' header inline it
// after the header, and the explorer inlines it into its template. It
// serves every [data-weft-theme] button on the page, so they all show one
// state, and runs once however often it is included.
//
// The page follows the device until the button is pressed. A press flips
// light and dark: the new theme is kept in localStorage under the key in
// data-weft-theme (the first button's), unless it is the device's own
// theme, when the stored choice is removed and the page follows the device
// again. data-always-set makes following the device write the device's
// theme to <html data-theme> rather than remove it (Starlight's styles need
// data-theme set). Changing the theme crossfades the page once, as a view
// transition; with reduced motion it changes at once.
//
// Semantics: a toggle button named "Dark theme", aria-pressed when the page
// is dark. Its description (the .weft-theme__desc inside it) says
// "Following your device", "Light" or "Dark"; its title says what the next
// press does. The page's live region, where it has one, hears the change.
(function () {
  var root = document.documentElement;
  if (root.hasAttribute("data-weft-theme-ready")) return;
  var buttons = Array.prototype.slice.call(document.querySelectorAll("[data-weft-theme]"));
  if (!buttons.length) return;
  root.setAttribute("data-weft-theme-ready", "");
  var key = buttons[0].getAttribute("data-weft-theme") || "weft-theme";
  var alwaysSet = buttons.some(function (b) {
    return b.hasAttribute("data-always-set");
  });
  var dark = matchMedia("(prefers-color-scheme: dark)");

  function device() {
    return dark.matches ? "dark" : "light";
  }
  function stored() {
    try {
      var t = localStorage.getItem(key);
      return t === "light" || t === "dark" ? t : null;
    } catch (e) {
      return null;
    }
  }
  function shown() {
    return stored() || device();
  }
  function cap(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  function sync() {
    var choice = stored();
    var now = shown();
    var other = now === "dark" ? "light" : "dark";
    buttons.forEach(function (b) {
      b.setAttribute("aria-pressed", String(now === "dark"));
      b.title = choice
        ? cap(now) + ", set on this site. Press to follow your device (" + device() + ")."
        : cap(now) + ", following your device. Press for " + other + ".";
      var desc = b.querySelector(".weft-theme__desc");
      if (desc) desc.textContent = choice ? cap(now) : "Following your device";
    });
  }
  function apply() {
    var choice = stored();
    if (choice) root.setAttribute("data-theme", choice);
    else if (alwaysSet) root.setAttribute("data-theme", device());
    else root.removeAttribute("data-theme");
    sync();
  }
  function say(text) {
    var live = document.getElementById("weft-status") || document.getElementById("live");
    if (!live) return;
    live.textContent = "";
    setTimeout(function () {
      live.textContent = text;
    }, 60);
  }
  function press() {
    var next = shown() === "dark" ? "light" : "dark";
    try {
      if (next === device()) localStorage.removeItem(key);
      else localStorage.setItem(key, next);
    } catch (e) {}
    var still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (document.startViewTransition && !still) {
      try {
        document.startViewTransition(apply);
      } catch (e) {
        apply();
      }
    } else apply();
    say(stored() ? cap(next) + " theme" : cap(next) + " theme, following your device");
  }

  sync();
  buttons.forEach(function (b) {
    b.addEventListener("click", press);
  });
  dark.addEventListener("change", function () {
    if (!stored() && alwaysSet) root.setAttribute("data-theme", device());
    sync();
  });
  // Another tab of the same site changed it.
  addEventListener("storage", function (e) {
    if (e.key === key) apply();
  });
})();
