import React from 'react';
import { StatusBar } from '../components/shell/StatusBar';
import { TabBar } from '../components/shell/TabBar';

const FRAME_L = {
  zh: {
    connected: '已连接',
    waiting: '等待连接',
    error: '连接故障',
    paused: '已暂停',
    chat: '对话',
    activity: '活动',
    settings: '设置',
    pause: '暂停所有 AI 操作',
    resume: '恢复',
    settingsTitle: '设置',
  },
  en: {
    connected: 'Connected',
    waiting: 'Waiting...',
    error: 'Connection error',
    paused: 'Paused',
    chat: 'Chat',
    activity: 'Activity',
    settings: 'Settings',
    pause: 'Pause all AI actions',
    resume: 'Resume',
    settingsTitle: 'Settings',
  },
};

export function PanelFrame({
  width = '100%',
  height = '100%',
  lang = 'zh',
  status = 'connected',
  tab = 'chat',
  activityDot = false,
  chrome = true,
  onTab,
  onStatusClick,
  onTogglePause,
  onSettings,
  children,
  overlay,
  style,
}) {
  const t = FRAME_L[lang] || FRAME_L.zh;
  return (
    <div style={{
      width,
      height,
      position: 'relative',
      display: 'flex',
      flexDirection: 'column',
      background: 'var(--bg-panel)',
      overflow: 'hidden',
      ...style,
    }}>
      {chrome ? (
        <StatusBar
          status={status}
          label={t[status]}
          onStatusClick={onStatusClick}
          onTogglePause={onTogglePause}
          onSettings={onSettings}
          pauseTitle={t.pause}
          resumeTitle={t.resume}
          settingsTitle={t.settingsTitle}
        />
      ) : null}
      <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>{children}</div>
      {chrome ? (
        <TabBar
          active={tab}
          onChange={onTab}
          tabs={[
            { id: 'chat', icon: 'message-square', label: t.chat },
            { id: 'activity', icon: 'list-checks', label: t.activity, dot: activityDot },
            { id: 'settings', icon: 'settings', label: t.settings },
          ]}
        />
      ) : null}
      {overlay}
    </div>
  );
}
