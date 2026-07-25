// mini-html-framework core

class HTMLRenderer {
  constructor() {
    this.componentRegistry = new Map();
  }

  registerComponent(name, component) {
    this.componentRegistry.set(name, component);
  }

  async renderFromJson(jsonArray, data = {}, containerSelector = 'body') {
    try {
      const container = document.querySelector(containerSelector);
      if (!container) {
        throw new Error(`Container element not found: ${containerSelector}`);
      }

      container.innerHTML = '';

      for (const item of jsonArray) {
        const el = await this._createElement(item, data);
        if (el) {
          container.appendChild(el);
        }
      }
    } catch (err) {
      console.error('JSON Rendering error:', err);
      throw err;
    }
  }

  async _createElement(item, data) {
    // Prüfen, ob es eine Komponente ist
    const componentName = item['data-component'] || item.component;
    if (componentName && this.componentRegistry.has(componentName)) {
      return await this.componentRegistry.get(componentName).render(data);
    }

    const tag = item.html_tag || 'div';
    const el = document.createElement(tag);

    // Setze Attribute (alle Keys außer html_tag, content, data-component, component, children)
    Object.entries(item).forEach(([key, value]) => {
      if (
        key !== 'html_tag' && 
        key !== 'content' && 
        key !== 'data-component' && 
        key !== 'component' && 
        key !== 'children'
      ) {
        el.setAttribute(key, value);
      }
    });

    // Inhalt mit Datenbindung {{key}} -> data[key]
    let content = item.content || '';
    Object.entries(data).forEach(([key, value]) => {
      const regex = new RegExp(`{{${key}}}`, 'g');
      content = content.replace(regex, value);
    });

    el.innerHTML = content;

    // Rekursives Rendern von Kindern
    if (Array.isArray(item.children)) {
      for (const child of item.children) {
        const childEl = await this._createElement(child, data);
        if (childEl) {
          el.appendChild(childEl);
        }
      }
    }

    return el;
  }

  render(template, data, containerSelector = 'body') {
    try {
      this._processTemplate(template, data, containerSelector);
    } catch (err) {
      console.error('Rendering error:', err);
      throw err;
    }
  }

  async _processTemplate(template, data, containerSelector) {
    try {
      const parser = new DOMParser();
      const templateDoc = parser.parseFromString(template, 'text/html');
      const container = document.querySelector(containerSelector);

      if (!container) {
        throw new Error(`Container element not found: ${containerSelector}`);
      }

      const components = [...templateDoc.querySelectorAll('*')];
      await this._renderComponents(components, data);
      container.innerHTML = '';
      container.appendChild(templateDoc.body);
    } catch (err) {
      throw new Error(`Template processing failed: ${err.message}`);
    }
  }

  async _renderComponents(components, data) {
    for (const component of components) {
      const componentName = component.getAttribute('data-component');
      if (componentName && this.componentRegistry.has(componentName)) {
        const renderedComponent = await this.componentRegistry.get(componentName).render(data);
        component.parentNode.replaceChild(renderedComponent, component);
      }
    }
  }
}

export default HTMLRenderer;
