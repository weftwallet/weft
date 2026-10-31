// The products switcher's behaviour (header.css has its markup and styles).
// Plain script with no imports: ProductSwitcher.astro imports it, and the
// explorer inlines the file into its template. It runs once per page and
// serves every [data-weft-switcher] on it.
//
// The menu is a .reversible (motion.css): .is-open on the list opens it, and
// taking the class away closes it from wherever it is, so opening and
// closing quickly never jumps. It closes on its button, on Escape (focus
// returns to the button), on a click outside it, and when focus leaves it.
(function () {
  document.querySelectorAll("[data-weft-switcher]").forEach(function (switcher) {
    var button = switcher.querySelector(".weft-switcher__button");
    var menu = switcher.querySelector(".weft-switcher__menu");
    if (!button || !menu) return;
    var isOpen = function () {
      return button.getAttribute("aria-expanded") === "true";
    };
    var set = function (open) {
      button.setAttribute("aria-expanded", String(open));
      menu.classList.toggle("is-open", open);
    };
    button.addEventListener("click", function () {
      set(!isOpen());
    });
    document.addEventListener("click", function (e) {
      if (isOpen() && !switcher.contains(e.target)) set(false);
    });
    switcher.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && isOpen()) {
        e.preventDefault();
        set(false);
        button.focus();
      }
    });
    switcher.addEventListener("focusout", function (e) {
      if (isOpen() && e.relatedTarget && !switcher.contains(e.relatedTarget)) set(false);
    });
  });
})();
