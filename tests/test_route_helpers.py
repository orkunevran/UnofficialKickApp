"""Tests for route helper functions and edge cases."""

from services.transformers import extract_thumbnail, extract_category_name


class TestExtractThumbnail:
    """Tests for the extract_thumbnail helper in transformers.py."""

    def test_prefers_src_over_url(self):
        data = {"thumbnail": {"src": "https://src.png", "url": "https://url.png"}}
        assert extract_thumbnail(data, None) == "https://src.png"

    def test_falls_back_to_url(self):
        data = {"thumbnail": {"url": "https://url.png"}}
        assert extract_thumbnail(data, None) == "https://url.png"

    def test_falls_back_to_profile_pic(self):
        data = {"thumbnail": {}}
        assert extract_thumbnail(data, "https://profile.png") == "https://profile.png"

    def test_no_thumbnail_key(self):
        assert extract_thumbnail({}, "https://fallback.png") == "https://fallback.png"

    def test_thumbnail_is_none(self):
        data = {"thumbnail": None}
        assert extract_thumbnail(data, "https://fallback.png") == "https://fallback.png"

    def test_thumbnail_is_string(self):
        """Non-dict thumbnail should fall back to profile pic."""
        data = {"thumbnail": "raw-string"}
        assert extract_thumbnail(data, "https://fallback.png") == "https://fallback.png"

    def test_all_none(self):
        assert extract_thumbnail({}, None) is None


class TestExtractCategoryName:
    """Tests for the extract_category_name helper in transformers.py."""

    def test_normal_categories(self):
        data = {"categories": [{"name": "Just Chatting"}]}
        assert extract_category_name(data) == "Just Chatting"

    def test_empty_list(self):
        data = {"categories": []}
        assert extract_category_name(data) is None

    def test_none_categories(self):
        data = {"categories": None}
        assert extract_category_name(data) is None

    def test_missing_key(self):
        assert extract_category_name({}) is None

    def test_first_element_not_dict(self):
        """If first category element is a string, not a dict, return None."""
        data = {"categories": ["Just Chatting"]}
        assert extract_category_name(data) is None

    def test_first_element_missing_name(self):
        data = {"categories": [{"id": 1}]}
        assert extract_category_name(data) is None

    def test_multiple_categories_returns_first(self):
        data = {"categories": [{"name": "Gaming"}, {"name": "IRL"}]}
        assert extract_category_name(data) == "Gaming"
