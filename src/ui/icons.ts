// Lucide icon names (kebab-case, as stored in .pen files) for the icon picker.
import { icons } from 'lucide-react';

export const ICON_NAMES: string[] = Object.keys(icons)
  .map(k => k.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([A-Z])([A-Z][a-z])/g, '$1-$2').replace(/([a-zA-Z])(\d)/g, '$1-$2').toLowerCase())
  .sort();
