function PlaceholderPage({ title }: { title: string }) {
  return (
    <div>
      <div className="page-heading">
        <h1>{title}</h1>
      </div>
      <div className="empty-state">
        <p>준비 중인 화면이에요.</p>
      </div>
    </div>
  );
}

export function NotificationSettingsPage() {
  return <PlaceholderPage title="알림 설정" />;
}

export function DeviceSettingsPage() {
  return <PlaceholderPage title="장치·센서" />;
}

export function AccountSettingsPage() {
  return <PlaceholderPage title="개인정보·계정" />;
}
