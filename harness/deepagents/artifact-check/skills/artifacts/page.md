# Page

A Page is one self-contained HTML file: publish it with `file_path` = the page. It runs its scripts in a sandbox. Its scripts load libraries only from cdn.jsdelivr.net, cdnjs.cloudflare.com or unpkg.com, each pinned to an exact version `<package>@<x.y.z>` (`https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js`, never `chart.js` or `chart.js@4`). Put everything else inline: the page reaches no other host, and fetches nothing.

Use semantic HTML with no classes. Load only this stock stylesheet:

```html
<link
  rel="stylesheet"
  href="https://cdn.jsdelivr.net/npm/@picocss/pico@2.1.1/css/pico.classless.min.css"
/>
<style>
  :root {
    --pico-primary: #0d74ce;
    --pico-primary-hover: #0d74ce;
    --pico-primary-background: #0d74ce;
    --pico-primary-border: #0d74ce;
    --pico-primary-inverse: #fff;
    --pico-color: #202020;
    --pico-muted-color: #646464;
    --pico-background-color: #fff;
    --pico-card-background-color: #fff;
    --pico-muted-border-color: #e8e8e8;
  }
</style>
```

Keep colour changes in this small `:root` block, through Pico's own variables. Add no other CSS.
