/** A physical-name template filled from a deployment's `name`: `{name}` is it, `{snake}` it with `_` for `-`, `{compact}` it without `-`. */
function fillName(template, name) {
  return template.replaceAll('{name}', name).replaceAll('{snake}', name.replaceAll('-', '_')).replaceAll('{compact}', name.replaceAll('-', ''));
}

module.exports = { fillName };
