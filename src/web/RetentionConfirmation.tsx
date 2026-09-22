import { useEffect, useRef } from 'react';

export function RetentionConfirmation({ active, busy, onClose, onConfirm }: {
  active: boolean; busy: boolean; onClose: () => void; onConfirm: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return <dialog ref={ref} className="retention-dialog" aria-labelledby="retention-title" onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <h2 id="retention-title">{active ? '确认长期保持' : '恢复时间衰减'}</h2>
    <p>{active ? '该节点将固定显示为「长期保持（本人确认）」，不随时间变化。只有你手动恢复衰减才会解除；资料更新、阅读或回忆结果都不会自动解除。' : '解除固定状态，按已有重温起点和当前半衰时间计算。没有重温起点时会回到「尚未评估」；这次切换不会新增复习记录。'}</p>
    <p className="source-hint">{active ? '这项标记表达你的管理决定，不代表经过测试的永久记忆。' : '原有学习历史和长期保持的切换记录都会保留。'}</p>
    <div className="modal-actions"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button type="button" className="primary-button" disabled={busy} onClick={onConfirm}>{busy ? '保存中…' : active ? '确认长期保持' : '确认恢复衰减'}</button></div>
  </dialog>;
}
