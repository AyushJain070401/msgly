/**
 * Marks simple-icons no longer ships (dropped over trademark policy): Slack,
 * Microsoft Teams, Outlook, Twilio, Amazon SES, SendGrid, and the SMS vendors
 * whose logos are wordmarks. Drawn here from each brand's own geometry, in
 * each brand's own colours, on a 24x24 grid to match the simple-icons set.
 */
import type { ReactElement } from 'react';

export const customMarks: Record<string, { hex: string; node: ReactElement }> = {
  '@msgly/slack': {
    hex: '#611f69',
    node: (
      <g>
        <path
          fill="#36C5F0"
          d="M8.5 2.5a2 2 0 1 1 0 4h-2v-2a2 2 0 0 1 2-2Zm0 5.3a2 2 0 0 1 0 4h-5a2 2 0 1 1 0-4h5Z"
        />
        <path
          fill="#2EB67D"
          d="M21.5 8.5a2 2 0 1 1-4 0v-2h2a2 2 0 0 1 2 2Zm-5.3 0a2 2 0 0 1-4 0v-5a2 2 0 1 1 4 0v5Z"
        />
        <path
          fill="#ECB22E"
          d="M15.5 21.5a2 2 0 1 1 0-4h2v2a2 2 0 0 1-2 2Zm0-5.3a2 2 0 0 1 0-4h5a2 2 0 1 1 0 4h-5Z"
        />
        <path
          fill="#E01E5A"
          d="M2.5 15.5a2 2 0 1 1 4 0v2h-2a2 2 0 0 1-2-2Zm5.3 0a2 2 0 0 1 4 0v5a2 2 0 1 1-4 0v-5Z"
        />
      </g>
    ),
  },

  '@msgly/msteams': {
    hex: '#6264A7',
    node: (
      <g>
        <circle cx="17.4" cy="5.6" r="2.9" fill="#5059C9" />
        <path fill="#5059C9" d="M15.6 9.6h6.1a1 1 0 0 1 1 1v4.1a3.6 3.6 0 0 1-3.6 3.6h-.4a3.6 3.6 0 0 1-3.6-3.6V9.6Z" />
        <circle cx="9.4" cy="5" r="3.6" fill="#7B83EB" />
        <path fill="#7B83EB" d="M3.3 9.6h12.2a1 1 0 0 1 1 1v5.1a5.9 5.9 0 0 1-5.9 5.9h-.4a5.9 5.9 0 0 1-5.9-5.9v-5.1a1 1 0 0 1 1-1Z" />
        <rect x="1" y="6.2" width="11.6" height="11.6" rx="1.4" fill="#4B53BC" />
        <path fill="#fff" d="M4 8.9h6.6v1.5H8.1v5.2H6.5v-5.2H4V8.9Z" />
      </g>
    ),
  },

  '@msgly/outlook': {
    hex: '#0078D4',
    node: (
      <g>
        <path fill="#0078D4" d="M23 7.4v9.2a.9.9 0 0 1-.9.9h-9.6V6.5h9.6a.9.9 0 0 1 .9.9Z" opacity=".55" />
        <path fill="#0078D4" d="M12.5 6.5h9.6a.9.9 0 0 1 .9.9v.5l-5.4 3.6-5.1-3.4V6.5Z" />
        <rect x="1" y="3.6" width="12.4" height="16.8" rx="1.3" fill="#0364B8" />
        <path
            fill="#fff"
            d="M7.2 7.7c-2 0-3.4 1.8-3.4 4.3s1.4 4.3 3.4 4.3 3.4-1.8 3.4-4.3-1.4-4.3-3.4-4.3Zm0 6.9c-1 0-1.7-1-1.7-2.6s.7-2.6 1.7-2.6 1.7 1 1.7 2.6-.7 2.6-1.7 2.6Z"
        />
      </g>
    ),
  },

  '@msgly/twilio-sms': {
    hex: '#F22F46',
    node: (
      <g>
        <path
          fill="#F22F46"
          d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.6 0 12 0Zm0 20.9c-4.9 0-8.9-4-8.9-8.9S7.1 3.1 12 3.1s8.9 4 8.9 8.9-4 8.9-8.9 8.9Z"
        />
        <circle cx="14.9" cy="9.1" r="2.5" fill="#F22F46" />
        <circle cx="14.9" cy="14.9" r="2.5" fill="#F22F46" />
        <circle cx="9.1" cy="9.1" r="2.5" fill="#F22F46" />
        <circle cx="9.1" cy="14.9" r="2.5" fill="#F22F46" />
      </g>
    ),
  },

  '@msgly/ses': {
    hex: '#FF9900',
    node: (
      <g>
        <rect x="1.5" y="4.5" width="21" height="15" rx="2.2" fill="#FF9900" />
        <path fill="#fff" d="M3.9 7.3h16.2L12 13.2 3.9 7.3Z" />
        <path fill="#fff" opacity=".85" d="M3.6 16.9v-6.6l4.9 3.4-4.9 3.2Zm16.8 0-4.9-3.2 4.9-3.4v6.6Z" />
      </g>
    ),
  },

  '@msgly/twilio-voice': {
    hex: '#F22F46',
    node: (
      <g>
        <circle cx="12" cy="12" r="11" fill="#F22F46" />
        <path
          fill="#fff"
          d="M8.4 6.6c.5 0 .8.3 1 .7l.9 2.1c.2.4.1.9-.3 1.2l-.9.7a7.6 7.6 0 0 0 3.6 3.6l.7-.9c.3-.4.8-.5 1.2-.3l2.1.9c.4.2.7.5.7 1v2.1c0 .7-.6 1.3-1.3 1.2A12.4 12.4 0 0 1 5.2 7.9c-.1-.7.5-1.3 1.2-1.3h2Z"
        />
      </g>
    ),
  },

  '@msgly/sendgrid': {
    hex: '#1A82E2',
    node: (
      <g>
        <rect x="1.5" y="1.5" width="7" height="7" fill="#99E1F4" />
        <rect x="8.5" y="1.5" width="7" height="7" fill="#00B3E3" />
        <rect x="8.5" y="8.5" width="7" height="7" fill="#1A82E2" />
        <rect x="1.5" y="8.5" width="7" height="7" fill="#00B3E3" />
        <rect x="15.5" y="8.5" width="7" height="7" fill="#99E1F4" />
        <rect x="8.5" y="15.5" width="7" height="7" fill="#99E1F4" />
      </g>
    ),
  },

  '@msgly/msg91': {
    hex: '#0052CC',
    node: (
      <g>
        <rect x="1" y="1" width="22" height="22" rx="5" fill="#0052CC" />
        <text
          x="12"
          y="16.4"
          textAnchor="middle"
          fill="#fff"
          fontFamily="ui-monospace, monospace"
          fontSize="10.5"
          fontWeight="700"
        >
          91
        </text>
      </g>
    ),
  },

  '@msgly/exotel': {
    hex: '#3AA0E0',
    node: (
      <g>
        <rect x="1" y="1" width="22" height="22" rx="5" fill="#3AA0E0" />
        <path
          fill="#fff"
          d="M9.1 6.6c.4 0 .7.2.9.6l.8 1.8c.2.4.1.8-.3 1.1l-.7.5a6.6 6.6 0 0 0 3 3l.5-.7c.3-.3.7-.4 1.1-.3l1.8.8c.4.2.6.5.6.9v1.8c0 .6-.5 1.1-1.1 1a10.7 10.7 0 0 1-9.7-9.7c0-.6.4-1.1 1-1.1h2.1Z"
        />
      </g>
    ),
  },

  '@msgly/plivo': {
    hex: '#FB5D2D',
    node: (
      <g>
        <rect x="1" y="1" width="22" height="22" rx="5" fill="#FB5D2D" />
        <path fill="#fff" d="M7.4 6.4h4.4a3.9 3.9 0 0 1 0 7.8H9.6v3.4H7.4V6.4Zm2.2 2v3.8h2.2a1.9 1.9 0 0 0 0-3.8H9.6Z" />
      </g>
    ),
  },

  '@msgly/telnyx': {
    hex: '#00E3AA',
    node: (
      <g>
        <rect x="1" y="1" width="22" height="22" rx="5" fill="#00C08B" />
        <path fill="#fff" d="M5.6 6.6h12.8v2.2h-5.3v8.6h-2.2V8.8H5.6V6.6Z" />
      </g>
    ),
  },

  '@msgly/smtp': {
    hex: '#4C5670',
    node: (
      <g>
        <rect x="1.5" y="4.5" width="21" height="15" rx="2.6" fill="#4C5670" />
        <path fill="none" stroke="#fff" strokeWidth="1.6" strokeLinejoin="round" d="m3.6 7.2 8.4 6 8.4-6" />
      </g>
    ),
  },

  '@msgly/core': {
    hex: '#1F6FEB',
    node: (
      <g>
        <circle cx="12" cy="12" r="3.4" fill="#1F6FEB" />
        <circle cx="12" cy="12" r="8" fill="none" stroke="#1F6FEB" strokeOpacity=".45" strokeWidth="1.4" strokeDasharray="3 3" />
        <circle cx="12" cy="4" r="1.9" fill="#7C4DFF" />
        <circle cx="19" cy="16" r="1.9" fill="#00A884" />
        <circle cx="5" cy="16" r="1.9" fill="#FF9900" />
      </g>
    ),
  },
};
