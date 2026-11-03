package web

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
)

// AddUserInteractive creates (or, after confirmation, resets) a web login from the console: it asks for the display
// name, whether the user is an admin and the password (typed twice, not echoed). Meant for `open890rc -adduser LOGIN`,
// i.e. someone with a shell on the machine — the same person who could edit the users file directly — so it opens no
// new way in from the network. SetUsersFile must have been called first. A running server does not reread the file:
// restart it afterwards.
func AddUserInteractive(login string, in *os.File, out io.Writer) error {
	if !validUserName.MatchString(login) {
		return errors.New("login: 1-8 characters (letters, digits, . _ -)")
	}
	rd := bufio.NewReader(in)
	ask := func(prompt string) (string, error) {
		fmt.Fprint(out, prompt)
		line, err := rd.ReadString('\n')
		if err != nil && (err != io.EOF || line == "") {
			return "", err
		}
		return strings.TrimSpace(line), nil
	}
	askPassword := func(prompt string) (string, error) {
		fmt.Fprint(out, prompt)
		// no echo: stty on the same terminal (no extra dependency; no-op error if stdin is not a terminal)
		off := exec.Command("stty", "-echo")
		off.Stdin = in
		hidden := off.Run() == nil
		if hidden {
			defer func() {
				on := exec.Command("stty", "echo")
				on.Stdin = in
				_ = on.Run()
				fmt.Fprintln(out)
			}()
		}
		line, err := rd.ReadString('\n')
		if err != nil && (err != io.EOF || line == "") {
			return "", err
		}
		return strings.TrimRight(line, "\r\n"), nil
	}
	yes := func(s string) bool {
		s = strings.ToLower(s)
		return s == "y" || s == "yes" || s == "j" || s == "ja"
	}

	auth.mu.Lock()
	_, exists := auth.users[login]
	auth.mu.Unlock()
	if exists {
		a, err := ask(fmt.Sprintf("User %q already exists. Reset password and settings? [y/N]: ", login))
		if err != nil {
			return err
		}
		if !yes(a) {
			return errors.New("aborted, nothing changed")
		}
	}
	display, err := ask("Name (display name, optional): ")
	if err != nil {
		return err
	}
	if len([]rune(display)) > 40 {
		return errors.New("name: at most 40 characters")
	}
	adminAnswer, err := ask("Admin user (may use settings and user management)? [y/N]: ")
	if err != nil {
		return err
	}
	pw, err := askPassword("Password (min. 6 characters): ")
	if err != nil {
		return err
	}
	if len(pw) < 6 {
		return errors.New("password: at least 6 characters")
	}
	pw2, err := askPassword("Password again: ")
	if err != nil {
		return err
	}
	if pw != pw2 {
		return errors.New("the passwords do not match")
	}
	hash, err := hashPassword(pw)
	if err != nil {
		return err
	}
	auth.mu.Lock()
	defer auth.mu.Unlock()
	auth.users[login] = hash
	if display != "" {
		auth.names[login] = display
	} else {
		delete(auth.names, login)
	}
	if yes(adminAnswer) {
		auth.admins[login] = true
	} else {
		delete(auth.admins, login)
	}
	delete(auth.noTX, login) // may transmit, like a user created in the browser
	if err := auth.saveLocked(); err != nil {
		return err
	}
	role := "user"
	if auth.admins[login] {
		role = "admin"
	}
	fmt.Fprintf(out, "Saved %s %q to %s. Restart a running open890rc so it reads the file.\n", role, login, auth.path)
	return nil
}
