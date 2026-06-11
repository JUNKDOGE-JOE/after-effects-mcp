import React from 'react';
import {
  Sparkles, Pause, Play, Shield, ShieldAlert, Undo2, Plug, Check, X,
  CircleSlash, Stethoscope, ChevronDown, ChevronRight, Settings, Copy,
  RotateCw, TriangleAlert, Search, Send, Square, Plus, Eye, EyeOff,
  ExternalLink, FileText, Trash2, History, MessageSquare, ListChecks, Globe,
  List, Download, BookOpen, Github, ArrowUp, CircleAlert, Info, Circle,
} from 'lucide-react';

const MAP = {
  sparkles: Sparkles, pause: Pause, play: Play, shield: Shield,
  'shield-alert': ShieldAlert, 'undo-2': Undo2, plug: Plug, check: Check,
  x: X, 'circle-slash': CircleSlash, stethoscope: Stethoscope,
  'chevron-down': ChevronDown, 'chevron-right': ChevronRight,
  settings: Settings, copy: Copy, 'rotate-cw': RotateCw,
  'triangle-alert': TriangleAlert, search: Search, send: Send, square: Square,
  plus: Plus, eye: Eye, 'eye-off': EyeOff, 'external-link': ExternalLink,
  'file-text': FileText, 'trash-2': Trash2, history: History,
  'message-square': MessageSquare, 'list-checks': ListChecks, globe: Globe,
  list: List, download: Download, 'book-open': BookOpen, github: Github,
  'arrow-up': ArrowUp, 'circle-alert': CircleAlert, info: Info, circle: Circle,
};

export function Icon({ name, size = 14, strokeWidth = 1.75, color = 'currentColor', style }) {
  const C = MAP[name];
  if (!C) return null;
  return <C size={size} strokeWidth={strokeWidth} color={color} style={style} aria-hidden="true" />;
}
