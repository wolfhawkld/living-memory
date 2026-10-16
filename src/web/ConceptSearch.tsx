import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import type { Concept } from '../shared/types.js';
import { domainIdOf, domainLabel } from '../core/domain-view.js';
import {
  normalizeSearchText,
  searchConcepts,
  type ConceptSearchHit,
} from './concept-search.js';
import './concept-search.css';

export interface ConceptSearchProps {
  concepts: readonly Concept[];
  currentDomainId: string | null;
  disabled?: boolean;
  onSelect: (conceptId: string) => void;
  onStartQueryReflection?: (entry: QueryReflectionEntry) => void;
  queryReflectionDisabled?: boolean;
}

export interface QueryReflectionEntry {
  query: string;
  hintedConceptIds: readonly string[];
}

function domainText(concept: Concept): string {
  const id = domainIdOf(concept);
  if (id === '__root__') return domainLabel(id);
  return `${domainLabel(id)} · ${id}`;
}

function aliasText(hit: ConceptSearchHit): string | null {
  if (!hit.matchedAlias) return null;
  return normalizeSearchText(hit.matchedAlias) === normalizeSearchText(hit.concept.title)
    ? null
    : hit.matchedAlias;
}

export function ConceptSearch({
  concepts,
  currentDomainId,
  disabled = false,
  onSelect,
  onStartQueryReflection,
  queryReflectionDisabled = false,
}: ConceptSearchProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const shownConceptIdsRef = useRef(new Set<string>());
  const generatedId = useId().replace(/[^a-zA-Z0-9_-]/gu, '');
  const inputId = `living-memory-concept-search-${generatedId}`;
  const listboxId = `${inputId}-listbox`;
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const search = useMemo(
    () => searchConcepts(concepts, query, { currentDomainId }),
    [concepts, currentDomainId, query],
  );
  const normalizedQuery = normalizeSearchText(query);
  const menuVisible = !disabled && open && normalizedQuery.length > 0;
  const activeId = menuVisible && activeIndex >= 0 && activeIndex < search.items.length
    ? `${listboxId}-option-${activeIndex}`
    : undefined;
  const shortcut = typeof navigator !== 'undefined' && /Mac|iPad|iPhone/u.test(navigator.platform) ? '⌘ K' : 'Ctrl K';

  useEffect(() => {
    if (!menuVisible) return;
    for (const hit of search.items) shownConceptIdsRef.current.add(hit.concept.id);
  }, [menuVisible, search.items]);

  useEffect(() => {
    if (!activeId) return;
    listboxRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [activeId]);

  useEffect(() => {
    setQuery('');
    setOpen(false);
    setActiveIndex(-1);
  }, [currentDomainId]);

  useEffect(() => {
    if (!disabled) return;
    setOpen(false);
    setActiveIndex(-1);
  }, [disabled]);

  useEffect(() => {
    if (activeIndex >= search.items.length && search.items.length > 0) {
      setActiveIndex(0);
    } else if (search.items.length === 0 && activeIndex !== -1) {
      setActiveIndex(-1);
    }
  }, [activeIndex, search.items.length]);

  useEffect(() => {
    const handleShortcut = (event: globalThis.KeyboardEvent) => {
      if (disabled || (!event.metaKey && !event.ctrlKey) || event.key.toLowerCase() !== 'k') return;
      event.preventDefault();
      inputRef.current?.focus();
      setOpen(true);
    };
    document.addEventListener('keydown', handleShortcut);
    return () => document.removeEventListener('keydown', handleShortcut);
  }, [disabled]);

  function selectIndex(index: number): void {
    if (disabled) return;
    const hit = search.items[index];
    if (!hit) return;
    setQuery('');
    setOpen(false);
    setActiveIndex(-1);
    inputRef.current?.focus();
    onSelect(hit.concept.id);
  }

  function handleInputChange(value: string): void {
    setQuery(value);
    setActiveIndex(-1);
    setOpen(normalizeSearchText(value).length > 0);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || composingRef.current) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      setActiveIndex(-1);
      return;
    }

    if (disabled || !normalizedQuery || search.items.length === 0) return;
    if (!menuVisible) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setOpen(true);
        setActiveIndex(event.key === 'ArrowDown' ? 0 : search.items.length - 1);
      }
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % search.items.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => (index <= 0 ? search.items.length - 1 : index - 1));
    } else if (event.key === 'Home' && activeIndex >= 0) {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === 'End' && activeIndex >= 0) {
      event.preventDefault();
      setActiveIndex(search.items.length - 1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      selectIndex(activeIndex >= 0 ? activeIndex : 0);
    }
  }

  function handleBlur(event: FocusEvent<HTMLDivElement>): void {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    setOpen(false);
    setActiveIndex(-1);
  }

  function keepInputFocus(event: MouseEvent<HTMLButtonElement>): void {
    event.preventDefault();
  }

  function clearQuery(): void {
    setQuery('');
    setOpen(false);
    setActiveIndex(-1);
    inputRef.current?.focus();
  }

  function startQueryReflection(): void {
    if (disabled || queryReflectionDisabled || !onStartQueryReflection) return;
    const hintedConceptIds = new Set(shownConceptIdsRef.current);
    if (menuVisible) for (const hit of search.items) hintedConceptIds.add(hit.concept.id);
    setOpen(false);
    setActiveIndex(-1);
    onStartQueryReflection({ query, hintedConceptIds: [...hintedConceptIds] });
  }

  return (
    <div className={`concept-search${disabled ? ' concept-search-is-disabled' : ''}`} onBlur={handleBlur}>
      <label className="concept-search-label" htmlFor={inputId}>搜索概念</label>
      <div className="concept-search-control">
        <span className="concept-search-icon" aria-hidden="true">⌕</span>
        <input
          ref={inputRef}
          id={inputId}
          className="concept-search-input"
          type="search"
          role="combobox"
          value={query}
          onChange={(event) => handleInputChange(event.currentTarget.value)}
          onFocus={() => {
            if (normalizedQuery) setOpen(true);
          }}
          onKeyDown={handleKeyDown}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { composingRef.current = false; }}
          placeholder="搜索全库概念、别名或摘要"
          aria-label="搜索概念"
          aria-autocomplete="list"
          aria-expanded={menuVisible}
          aria-controls={listboxId}
          aria-activedescendant={activeId}
          disabled={disabled}
        />
        {query.length > 0 ? (
          <button
            type="button"
            className="concept-search-clear"
            aria-label="清空搜索"
            onMouseDown={keepInputFocus}
            onClick={clearQuery}
            disabled={disabled}
          >
            ×
          </button>
        ) : null}
        <kbd className="concept-search-shortcut" aria-hidden="true">{shortcut}</kbd>
      </div>

      {onStartQueryReflection ? <button type="button" className="concept-search-reflect"
        disabled={disabled || queryReflectionDisabled} onClick={startQueryReflection}
        title="先保留原始想法，再检索资料；也可以直接使用上方搜索。">先想一下再查</button> : null}

      {menuVisible ? (
        <div className="concept-search-menu">
          <div className="concept-search-meta" role="status">
            {search.totalMatches > search.items.length
              ? `匹配 ${search.totalMatches} 项 · 显示前 ${search.items.length} 项，可继续输入缩小范围`
              : search.totalMatches > 0 ? `匹配 ${search.totalMatches} 项` : '没有匹配概念'}
          </div>
          <div ref={listboxRef} id={listboxId} className="concept-search-listbox" role="listbox" aria-label="概念搜索结果">
            {search.items.length > 0 ? search.items.map((hit, index) => {
              const alias = aliasText(hit);
              return (
                <button
                  type="button"
                  role="option"
                  id={`${listboxId}-option-${index}`}
                  className={`concept-search-option${activeIndex === index ? ' concept-search-option-is-active' : ''}`}
                  aria-selected={activeIndex === index}
                  title={`${hit.concept.title}\n${hit.concept.source.path}`}
                  tabIndex={-1}
                  key={`${hit.concept.id}-${index}`}
                  onMouseDown={keepInputFocus}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => selectIndex(index)}
                >
                  <span className="concept-search-option-title">{hit.concept.title}</span>
                  <span className="concept-search-option-detail">
                    <span>{domainText(hit.concept)}</span>
                    {alias ? <span> · 别名：{alias}</span> : null}
                  </span>
                </button>
              );
            }) : (
              <div className="concept-search-empty" role="status">试试名称、别名或摘要。</div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
