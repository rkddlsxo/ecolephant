import * as Dialog from '@radix-ui/react-dialog';
import * as Switch from '@radix-ui/react-switch';
import { cva, type VariantProps } from 'class-variance-authority';
import { X } from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

const button = cva('button', {
  variants: {
    variant: {
      primary: 'button-primary',
      secondary: 'button-secondary',
      ghost: 'button-ghost',
      danger: 'button-danger',
    },
  },
  defaultVariants: { variant: 'primary' },
});
export function Button({
  className = '',
  variant,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof button>) {
  return <button className={button({ variant, className })} {...props} />;
}
export function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="toggle-label">
      <span>{label}</span>
      <Switch.Root
        className="switch"
        checked={checked}
        onCheckedChange={onChange}
        aria-label={label}
      >
        <Switch.Thumb className="switch-thumb" />
      </Switch.Root>
    </label>
  );
}
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content">
          <Dialog.Title>{title}</Dialog.Title>
          <Dialog.Description>{description}</Dialog.Description>
          <Dialog.Close className="icon-button close-button" aria-label="닫기">
            <X size={19} />
          </Dialog.Close>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function Notice({
  children,
  kind = 'info',
}: {
  children: ReactNode;
  kind?: 'info' | 'error';
}) {
  return (
    <div className={`notice notice-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}
export function Loading() {
  return (
    <div className="empty-state" role="status">
      <span className="spinner" />
      기록을 불러오고 있어요.
    </div>
  );
}
export function ErrorState({ error, retry }: { error: string; retry: () => void }) {
  return (
    <Notice kind="error">
      {error}{' '}
      <button className="text-button" onClick={retry}>
        다시 시도
      </button>
    </Notice>
  );
}
export function formatDuration(ms: number) {
  const seconds = Math.floor(ms / 1000);
  return seconds >= 3600
    ? `${Math.floor(seconds / 3600)}시간 ${Math.floor((seconds % 3600) / 60)}분`
    : `${Math.floor(seconds / 60)}분 ${seconds % 60}초`;
}
export function formatDate(value: string) {
  return new Intl.DateTimeFormat('ko-KR', {
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Seoul',
  }).format(new Date(value));
}
export const modeLabel = {
  combined: '웹캠 + AirPods',
  webcam: '웹캠',
  airpods: 'AirPods',
  none: '센서 없음',
};
