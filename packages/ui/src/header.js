// The header's order (header.css has its markup and styles). Plain script
// with no imports: Shell.astro and the docs' header import it, and the
// explorer inlines the file into its template. It runs once per page.
//
// 1. Reading order. On a narrow screen the CSS places the header's items in
//    rows by their order, which leaves focus and a screen reader following
//    the markup: the links first, though they are drawn under the tools.
//    This puts the bar's children in the order they are drawn, by row and
//    then from the start of the row, whenever the bar changes size (which
//    includes crossing a breakpoint). It never changes what is drawn: each
//    item is placed by its order, and items with the same order keep theirs.
//    Anything the bar holds that is not drawn in a row (hidden, or
//    positioned, like a note under a button) moves with the item before it.
// 2. The header's height, as --weft-head-height on <html>, for the scroll
//    padding that keeps an anchor clear of the sticky header.
(function () {
  var root = document.documentElement;

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

  document.querySelectorAll(".shell-bar").forEach(function (bar) {
    if (typeof ResizeObserver === "undefined") return;
    new ResizeObserver(function () { arrange(bar); }).observe(bar);
  });

  var head = document.querySelector(".shell-head");
  if (head && typeof ResizeObserver !== "undefined") {
    new ResizeObserver(function () {
      root.style.setProperty("--weft-head-height", head.offsetHeight + "px");
    }).observe(head);
  }
})();
