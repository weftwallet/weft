// The header's layout (header.css has its markup and styles). Plain script
// with no imports: Shell.astro and the docs' header inline it right after
// the header, and the explorer inlines it into its template at the same
// place, so it runs before the first paint. It runs once per page.
//
// 1. The links. They never scroll: this sets data-links on the bar to the
//    first layout in which they fit (header.css lists them), measuring
//    whenever the bar's width changes and once the fonts have loaded.
// 2. Reading order. The CSS places the header's items by their order, which
//    leaves focus and a screen reader following the markup. This puts the
//    bar's children in the order they are drawn, by row and then from the
//    start of the row. It never changes what is drawn: each item is placed
//    by its order, and items with the same order keep theirs. Anything the
//    bar holds that is not drawn in a row (hidden, or positioned, like a
//    note under a button) moves with the item before it.
// 3. Search on a phone. [data-shell-search-open] opens the field across
//    the bar (aria-controls), as a .reversible (motion.css), and puts focus
//    in it. Escape, the close button, a click outside it or focus leaving
//    it close it, and focus returns to the button where it was in the field.
// 4. The header's height, as --weft-head-height on <html>, for the scroll
//    padding that keeps an anchor clear of the sticky header (and, in the
//    docs, Starlight's --sl-nav-height).
(function () {
  var root = document.documentElement;
  var bars = Array.prototype.slice.call(document.querySelectorAll(".shell-bar"));
  if (!bars.length || bars[0].hasAttribute("data-links")) return;

  function fit(bar) {
    var nav = bar.querySelector(":scope > .shell-nav");
    if (!nav || !nav.querySelector("a")) {
      bar.setAttribute("data-links", "none");
      return;
    }
    var menu = bar.getAttribute("data-links-menu");
    var states = menu && matchMedia(menu).matches ? ["inline", "menu"] : ["inline", "row"].concat(nav.querySelector(".shell-nav__short") ? ["short"] : [], ["wrap"]);
    for (var i = 0; i < states.length; i++) {
      bar.setAttribute("data-links", states[i]);
      if (states[i] === "menu" || states[i] === "wrap") return;
      if (nav.scrollWidth <= nav.clientWidth + 0.5) return;
    }
  }

  function arrange(bar) {
    // A dialog opened from the header (the docs' search) leaves the top
    // layer if it is moved, so nothing moves while one is open.
    if (bar.querySelector("dialog[open], .is-open")) return;
    var rtl = getComputedStyle(bar).direction === "rtl";
    var items = [];
    Array.prototype.forEach.call(bar.children, function (el) {
      var cs = getComputedStyle(el);
      var placed = cs.display !== "none" && cs.position !== "absolute" && cs.position !== "fixed";
      if (placed || !items.length) {
        var box = el.getBoundingClientRect();
        items.push({ els: [el], y: box.top + box.height / 2, x: rtl ? -box.right : box.left });
      } else {
        items[items.length - 1].els.push(el);
      }
    });
    // Rows: items whose middles are within 16px of the row's first.
    var byY = items.slice().sort(function (a, b) { return a.y - b.y; });
    var row = 0;
    var rowY = byY.length ? byY[0].y : 0;
    byY.forEach(function (item) {
      if (item.y - rowY > 16) {
        row += 1;
        rowY = item.y;
      }
      item.row = row;
    });
    var drawn = items.slice().sort(function (a, b) { return a.row - b.row || a.x - b.x; });
    if (drawn.every(function (item, i) { return item === items[i]; })) return;
    var focused = document.activeElement;
    drawn.forEach(function (item) {
      item.els.forEach(function (el) { bar.appendChild(el); });
    });
    if (focused && focused !== document.activeElement && bar.contains(focused)) focused.focus({ preventScroll: true });
  }

  function height() {
    var bar = bars[0];
    var head = bar.closest("header");
    var border = head ? parseFloat(getComputedStyle(head).borderBottomWidth) || 0 : 0;
    root.style.setProperty("--weft-head-height", bar.offsetHeight + border + "px");
  }

  function search(bar) {
    bar.querySelectorAll("[data-shell-search-open]").forEach(function (button) {
      var pop = document.getElementById(button.getAttribute("aria-controls"));
      if (!pop) return;
      var isOpen = function () {
        return button.getAttribute("aria-expanded") === "true";
      };
      var set = function (open, focusButton) {
        button.setAttribute("aria-expanded", String(open));
        pop.classList.toggle("is-open", open);
        if (open) {
          var input = pop.querySelector("input");
          if (input) input.focus();
        } else if (focusButton) button.focus();
      };
      button.addEventListener("click", function () {
        set(!isOpen());
      });
      var close = pop.querySelector("[data-shell-search-close]");
      if (close) close.addEventListener("click", function () { set(false, true); });
      pop.addEventListener("keydown", function (e) {
        if (e.key === "Escape" && isOpen()) {
          e.preventDefault();
          set(false, true);
        }
      });
      pop.addEventListener("focusout", function (e) {
        if (isOpen() && e.relatedTarget && !pop.contains(e.relatedTarget) && e.relatedTarget !== button) set(false);
      });
      document.addEventListener("click", function (e) {
        if (isOpen() && !pop.contains(e.target) && !button.contains(e.target)) set(false);
      });
      // Wide enough for the field in the bar: the pop has gone with the button.
      bar.weftCloseSearch = function () {
        if (isOpen() && !button.offsetParent) set(false);
      };
    });
  }

  function layout(bar) {
    fit(bar);
    arrange(bar);
  }

  bars.forEach(function (bar) {
    search(bar);
    layout(bar);
    if (typeof ResizeObserver === "undefined") return;
    var width = bar.clientWidth;
    new ResizeObserver(function () {
      if (bar.clientWidth !== width) {
        width = bar.clientWidth;
        layout(bar);
        if (bar.weftCloseSearch) bar.weftCloseSearch();
      }
      height();
    }).observe(bar);
  });
  height();
  // The fonts change what the links need.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () {
      bars.forEach(layout);
      height();
    });
  }
})();
