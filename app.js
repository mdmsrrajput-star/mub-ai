const messageInput = document.getElementById("messageInput");
const sendButton = document.getElementById("sendButton");
const messages = document.getElementById("messages");

function addMessage(text, type) {
    const message = document.createElement("div");

    message.classList.add("message");

    if (type === "user") {
        message.classList.add("user-message");
    } else {
        message.classList.add("mub-message");
    }

    message.textContent = text;

    messages.appendChild(message);

    messages.scrollTop = messages.scrollHeight;
}

function sendMessage() {
    const text = messageInput.value.trim();

    if (text === "") {
        return;
    }

    // Show user's message
    addMessage(text, "user");

    // Clear input
    messageInput.value = "";

    // Temporary MuB response
    setTimeout(() => {
        addMessage(
            "I'm MuB. I received your message. My AI brain will be connected next.",
            "mub"
        );
    }, 500);
}

// Send button
sendButton.addEventListener("click", sendMessage);

// Press Enter to send
messageInput.addEventListener("keydown", function (event) {
    if (event.key === "Enter") {
        sendMessage();
    }
});