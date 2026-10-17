import type { Level } from '@ecolephant/ai';

export function PostureScene({
  level = 'normal',
  small = false,
}: {
  level?: Level;
  small?: boolean;
}) {
  const tilt = level === 'high' ? 20 : level === 'caution' ? 10 : 0;
  return (
    <svg
      className={small ? 'posture-scene small' : 'posture-scene'}
      viewBox="0 0 560 370"
      role="img"
      aria-label="데모 자세를 표현한 일러스트"
    >
      <defs>
        <pattern id="scene-grid" width="28" height="28" patternUnits="userSpaceOnUse">
          <path d="M 28 0 L 0 0 0 28" fill="none" stroke="#dbe6dc" strokeWidth="0.6" />
        </pattern>
      </defs>
      <rect width="560" height="370" fill="url(#scene-grid)" />
      <ellipse cx="287" cy="323" rx="164" ry="12" fill="#dde6d9" />
      <path
        d="M150 319V210Q150 192 168 192H241"
        fill="none"
        stroke="#9baea1"
        strokeWidth="9"
        strokeLinecap="round"
      />
      <path d="M209 318V276H294V319" fill="none" stroke="#9baea1" strokeWidth="7" />
      <path d="M357 318V246H476V318" fill="none" stroke="#839d8d" strokeWidth="6" />
      <path d="M326 242H480" stroke="#b29673" strokeWidth="11" strokeLinecap="round" />
      <path d="M378 240L359 193H430L448 240Z" fill="#507364" />
      <path d="M364 198H426L440 232H378Z" fill="#cbded3" />
      <path
        d="M216 274L287 276L304 319"
        fill="none"
        stroke="#274f44"
        strokeWidth="24"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M299 322H329" stroke="#38574b" strokeWidth="12" strokeLinecap="round" />
      <path d="M219 277L227 186" stroke="#799d83" strokeWidth="48" strokeLinecap="round" />
      <path
        d="M240 204L280 231L345 232"
        fill="none"
        stroke="#9bbb9d"
        strokeWidth="18"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <g
        style={{
          transform: `rotate(${tilt}deg)`,
          transformOrigin: '233px 184px',
          transition: 'transform 0.6s ease',
        }}
      >
        <path d="M231 185V159" stroke="#dfbea0" strokeWidth="20" strokeLinecap="round" />
        <ellipse cx="235" cy="133" rx="30" ry="37" fill="#e7c8aa" />
        <path d="M206 142Q185 92 227 91Q266 90 263 125L245 119L237 105L215 125Z" fill="#365245" />
        <circle cx="251" cy="133" r="2.5" fill="#294c3e" />
        <rect x="219" y="128" width="7" height="20" rx="3.5" fill="#fcfdf9" />
      </g>
      <path d="M233 117V267" stroke="#81a78e" strokeDasharray="5 6" opacity=".6" />
      <circle cx="233" cy="181" r="7" fill="#fff" stroke="#528a65" strokeWidth="3" />
      <circle cx="233" cy="133" r="5" fill="#fff" stroke="#528a65" strokeWidth="2" />
      <path d="M239 135L326 100H374" fill="none" stroke="#82a88e" strokeWidth="1.5" />
      <rect x="324" y="77" width="128" height="28" rx="14" fill="#fff" />
      <text x="388" y="95" textAnchor="middle" fontSize="11" fill="#4e7460">
        가상 입력 · 영상 아님
      </text>
      <path
        d="M125 116C117 96 131 79 144 81C152 69 171 79 165 93C188 93 187 116 174 119"
        fill="#ccdcbc"
      />
      <path d="M147 140V100" stroke="#92ab82" strokeWidth="3" />
      <path d="M128 140H166L161 163H133Z" fill="#dfd8c3" />
    </svg>
  );
}
