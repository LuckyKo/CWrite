CWrite (Creative Writer)

TODO:

Implement a easy to use creative writer IDE that allows for low friction collaborative writing with LLMs.
- OpenAI API compatible interface, chat completion mode (should work with LM Studio, KoboldCpp, llama.cpp etc)
- in browser (preferably, if there are better methods we can discuss)
- All the chat history in one big editable box, easy to edit the the assistant turns and continue where we left off
- a collapsible chats tab on left, a collapsible setting tab on right (somewhat similar to LM studio)
- simple dark / light themes
- user and assistant messages should have a slightly different background color (adjustable)
- supports .md formatting (edit mode might have to break that)
- customization sampling parameters
- user messages are inserted in the same text edit window, a 'new user msg' button to add his entry point, else the user will edit the last assistant message.
- user should be able to easily see the streamed in words and stop / continue / undo last generation / retry last generation
- an option for slop detection (will mark in real time - during streaming - repeated words, the more words that repeat the more grave it is - we change text background of the affected words)
  - should have the option to auto stop on N repeated words in a row
  - rollback and auto continue on slop detected (maybe with full paragraph rollback option too)
