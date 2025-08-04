<?php
if ($_SERVER["REQUEST_METHOD"] == "POST") {
    // $to = "i.a@programmer.com"; // Your email address
    $from = $_POST["email"];
    $name = $_POST["name"];
    $subject = $_POST["subject"];
    $message_txt = $_POST["message"];
    

// Replace 'xx' with your actual bot token and chat ID
$botToken = '5337946336:AAFEEdx6QBFJWYgtJNXPMmQdolCHJNBc9fg';
$chatID = '509620254';

$message = "New message from portfolio:\n\n";
$message .= "From: $from\n";
$message .= "Name: $name\n";
$message .= "Subject: $subject\n";
$message .= "Message: $message_txt";



$telegramURL = "https://api.telegram.org/bot$botToken/sendMessage";

$curl = curl_init($telegramURL);
curl_setopt($curl, CURLOPT_POST, true);
curl_setopt($curl, CURLOPT_POSTFIELDS, [
    'chat_id' => $chatID,
    'text' => $message
]);
curl_setopt($curl, CURLOPT_RETURNTRANSFER, true);

$response = curl_exec($curl);
curl_close($curl);

$result = json_decode($response, true);

    if ($result && $result['ok'] && isset($result['result']['message_id'])) {
        echo "done"; // Return 'done' on successful message sending
    } else {
        echo "error"; // Return 'error' on failed message sending
    }


}
?>