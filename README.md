# `@convokitapp/react-native-ui`

Controlled and SDK-backed ConvoKit chat components for bare React Native and
Expo. The package has no navigation, picker, filesystem, or Expo dependency.

```tsx
<ConvoKitConversationList
  sdk={client}
  onConversationSelected={setSelectedConversation}
/>

<ConvoKitConversation
  sdk={client}
  conversationId={selectedConversation.id}
  onBack={() => setSelectedConversation(null)}
/>
```

Use the `*View` components when application state is owned outside ConvoKit.
All major rows and states accept render callbacks, and `ConvoKitUiProvider`
provides platform-neutral theme tokens.

Pagination, optimistic sends, realtime reconciliation, deletion tombstones,
typing indicators, read receipts, and media rendering live in shared
controllers. Navigation, safe areas, pickers, downloads, and attachment
opening stay behind application callbacks. This package deliberately imports
neither Expo modules nor app-specific native libraries, keeping a future
`react-native-web` target open.

Publish `@convokitapp/react-native` before publishing this package.
