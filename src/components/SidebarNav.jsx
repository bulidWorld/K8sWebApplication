import React, { useEffect, useState } from 'react';
import { navigation, activeBranchIds, isNavigationActive } from '../lib/navigation.js';

export default function SidebarNav({ section, deploymentModule, data, onNavigate }) {
  const [expanded, setExpanded] = useState(() => new Set(['applications', 'deployment-group', ...activeBranchIds(section, deploymentModule)]));
  useEffect(() => {
    setExpanded(previous => new Set([...previous, ...activeBranchIds(section, deploymentModule)]));
  }, [section, deploymentModule]);

  function renderEntries(entries, depth = 1) {
    return <ul className={`nav-level nav-level-${depth}`}>
      {entries.map(entry => {
        const active = isNavigationActive(entry, section, deploymentModule);
        const open = expanded.has(entry.id);
        const childrenId = `sidebar-${entry.id}`;
        return <li key={entry.id}>
          {entry.children ? <>
            <button type="button" className={`nav-branch ${active ? 'has-active' : ''}`} aria-expanded={open} aria-controls={childrenId} onClick={() => setExpanded(previous => {
              const next = new Set(previous);
              if (next.has(entry.id)) next.delete(entry.id); else next.add(entry.id);
              return next;
            })}>
              {entry.icon && <span className="nav-icon" aria-hidden="true">{entry.icon}</span>}
              <span className="nav-text">{entry.label}</span><span className={`nav-chevron ${open ? 'is-expanded' : ''}`} aria-hidden="true">›</span>
            </button>
            <div id={childrenId} hidden={!open}>{renderEntries(entry.children, depth + 1)}</div>
          </> : <button type="button" className={`nav-leaf ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined} onClick={() => onNavigate(entry.section, entry.module || '')} title={entry.label}>
            {entry.icon && <span className="nav-icon" aria-hidden="true">{entry.icon}</span>}
            <span className="nav-text">{entry.label}</span>
            {entry.section !== 'overview' && !entry.module && data[entry.section] && <span className="nav-count">{data[entry.section].length}</span>}
          </button>}
        </li>;
      })}
    </ul>;
  }
  return <nav className="hierarchical-nav" aria-label="主导航">{renderEntries(navigation)}</nav>;
}
