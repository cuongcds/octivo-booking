# Octivo Booking

Embeddable booking widget for any Octivo CRM `type=website` channel. Self-contained — injects its own CSS and DOM into the host page, so it can be dropped into any third-party site with a single `<script>` tag.

Flow: choose branch (skipped if the org has only one) -> choose service -> choose staff (optional) -> choose date/time -> confirm, plus a list of the guest's existing reservations with cancel.

## Install via jsDelivr

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/octivo-booking@0.1.1/dist/octivo-booking.min.css">
<script src="https://cdn.jsdelivr.net/npm/octivo-booking@0.1.1/dist/octivo-booking.min.js" data-channel="your-channel-slug" async></script>
```

Replace `your-channel-slug` with your channel source id.

By default, the widget talks to `https://octivo.shplinks.com`. To point it at a different Octivo instance, add `data-host="https://your-instance.example.com"` to the `<script>` tag, or pass `host` to `init()`.

## Usage

```html
<script src="https://cdn.jsdelivr.net/npm/octivo-booking@0.1.1/dist/octivo-booking.min.js" data-channel="your-channel-slug" async></script>
<script>
  // optional, any time after the script tag:
  window.OctivoBooking.init({
    name: 'Jane', phone: '0901234567',
    showBubble: false,        // hide the floating button; open() from your own UI instead
    onClose: function () {},  // fired whenever the popup is closed
  });
  document.querySelector('#my-booking-button').addEventListener('click', OctivoBooking.open);
  window.addEventListener('octivobooking:close', function (e) { /* ... */ });
</script>
```

## Development

Source lives in `src/`. Build minified output with:

```bash
npx terser src/octivo-booking.js -c -m -o dist/octivo-booking.min.js
npx clean-css-cli -o dist/octivo-booking.min.css src/octivo-booking.css
```
